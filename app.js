// Detect and apply Cockpit's dark mode theme
function applyDarkMode() {
    try {
        const parentHtml = window.parent.document.documentElement;
        const isDark = parentHtml.classList.contains('pf-v5-theme-dark') ||
                      parentHtml.classList.contains('pf-v6-theme-dark');

        if (isDark) {
            document.documentElement.classList.add('pf-v6-theme-dark');
        } else {
            document.documentElement.classList.remove('pf-v6-theme-dark');
        }
    } catch (e) {
        const theme = localStorage.getItem('cockpit:style') || 'auto';
        if (theme === 'dark') {
            document.documentElement.classList.add('pf-v6-theme-dark');
        }
    }
}

applyDarkMode();

const observer = new MutationObserver(applyDarkMode);
try {
    observer.observe(window.parent.document.documentElement, {
        attributes: true,
        attributeFilter: ['class']
    });
} catch (e) {
    // Can't observe parent
}

var cockpit = window.cockpit;

// Sentinel for the "+ Add Tunnel" pseudo-tab.
var ADD_TAB = '__add__';

// Tracks the set of currently rendered units so rediscovery only re-renders
// when the set changes.
var renderedUnits = [];
var activeTab = null;

// Whether cloudflared is installed on the host. Detected by updateVersion().
// Starts optimistic so the button doesn't flicker to "Install" before
// detection resolves; set to false on the first failed version check.
var cloudflaredInstalled = true;

// Map `uname -m` output to the arch suffix cloudflared publishes binaries for
// at github.com/cloudflare/cloudflared/releases (see "Assets" on any release).
var ARCH_MAP = {
    'x86_64':  'amd64',
    'aarch64': 'arm64',
    'arm64':   'arm64',
    'armv7l':  'armhf',
    'armv6l':  'armhf',
    'armhf':   'armhf',
    'i686':    '386',
    'i386':    '386'
};

function detectArch(onSuccess, onError) {
    cockpit.spawn(["uname", "-m"], { err: "message" })
        .done(function(out) {
            var machine = out.trim();
            var arch = ARCH_MAP[machine];
            if (!arch) {
                onError('Unsupported architecture: ' + machine +
                        ' (no cloudflared binary published for this platform).');
                return;
            }
            onSuccess(arch);
        })
        .fail(onError);
}

function downloadCloudflaredBinary(arch, onSuccess, onError) {
    // arch comes from ARCH_MAP values (alphanumeric only), so it's safe to
    // embed in the shell command — no user input reaches this path.
    var url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-' + arch;
    cockpit.spawn([
        "bash", "-c",
        "set -e; " +
        "curl -fsSL --output /tmp/cloudflared '" + url + "'; " +
        "chmod +x /tmp/cloudflared; " +
        "cp /tmp/cloudflared /usr/local/bin/cloudflared; " +
        "rm -f /tmp/cloudflared"
    ], { superuser: "require", err: "message" })
        .done(onSuccess)
        .fail(onError);
}

// Configurable prefixes for stripping pasted Cloudflare commands. Loaded
// from ./token-prefixes.txt at startup; empty array is a safe default.
var tokenPrefixes = [];

function loadTokenPrefixes() {
    return fetch('token-prefixes.txt', { cache: 'no-store' })
        .then(function(res) { return res.ok ? res.text() : ''; })
        .then(function(text) {
            tokenPrefixes = text.split(/\r?\n/)
                .map(function(l) { return l.trim(); })
                .filter(function(l) { return l && l.charAt(0) !== '#'; });
        })
        .catch(function() { tokenPrefixes = []; });
}

// Strip a known leading command from a user paste and return just the token.
// Examples of handled paste shapes:
//   "sudo cloudflared service install eyJ..."       -> "eyJ..."
//   "cloudflared tunnel run --token eyJ..."          -> "eyJ..."
//   "cloudflared tunnel run --token=eyJ..."          -> "eyJ..."
//   "eyJ..."                                         -> "eyJ..."
function cleanToken(input) {
    var raw = (input || '').trim();
    if (!raw) return '';

    // Normalize internal whitespace to single spaces so "--token  eyJ..."
    // matches a prefix that ends in "--token".
    var normalized = raw.replace(/\s+/g, ' ');

    for (var i = 0; i < tokenPrefixes.length; i++) {
        var prefix = tokenPrefixes[i].replace(/\s+/g, ' ');
        if (!prefix) continue;
        if (normalized.indexOf(prefix) === 0) {
            var after = normalized.slice(prefix.length).replace(/^[\s=]+/, '');
            return after.split(/\s+/)[0];
        }
    }

    // No configured prefix matched. Fallback: take the last whitespace-
    // separated chunk. Covers "anything <TOKEN>" paste patterns even
    // without an explicit prefix entry. Strip a leading "=" for
    // "--token=VALUE" tails.
    var parts = normalized.split(/\s+/);
    return parts[parts.length - 1].replace(/^=/, '');
}

function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text == null ? '' : text;
    return div.innerHTML;
}

function showNotification(message, type) {
    type = type || 'info';
    var notification = document.createElement('div');
    notification.className = 'pf-v6-c-alert pf-m-' + type;
    notification.style.cssText = 'position: fixed; top: 20px; right: 20px; z-index: 9999; max-width: 400px;';

    var title = document.createElement('div');
    title.className = 'pf-v6-c-alert__title';
    title.textContent = message;
    notification.appendChild(title);

    document.body.appendChild(notification);

    setTimeout(function() {
        if (notification.parentNode) {
            notification.parentNode.removeChild(notification);
        }
    }, 5000);
}

// ------------------------------------------------------------------
// Global (shared cloudflared binary) — version + update
// ------------------------------------------------------------------

function setUpdateButtonMode(installed) {
    cloudflaredInstalled = installed;
    var btn = document.getElementById('update-btn');
    if (!btn) return;
    btn.textContent = installed ? 'Update Cloudflared' : 'Install Cloudflared';
}

// Latest upstream version as a [YYYY, M, P] tuple, null until fetched or on
// network failure. Cached across the session — fetched once at load.
var latestVersion = null;
var currentVersionString = null;

function parseVersionNumber(s) {
    var m = (s || '').match(/(\d+)\.(\d+)\.(\d+)/);
    return m ? [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)] : null;
}

function compareVersions(a, b) {
    for (var i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
}

function renderVersionDisplay(versionString) {
    var el = document.getElementById("version-info");
    if (!el) return;
    el.innerHTML = '';
    if (!versionString) {
        el.textContent = "Not installed";
        currentVersionString = null;
        return;
    }
    currentVersionString = versionString;
    el.appendChild(document.createTextNode(versionString));

    var current = parseVersionNumber(versionString);
    if (!current || !latestVersion) return;

    var pill = document.createElement('span');
    pill.className = 'version-pill';
    if (compareVersions(current, latestVersion) >= 0) {
        pill.classList.add('version-pill-latest');
        pill.textContent = 'you have the latest version';
    } else {
        pill.classList.add('version-pill-outdated');
        pill.textContent = 'update available: ' + latestVersion.join('.');
    }
    el.appendChild(document.createTextNode(' '));
    el.appendChild(pill);
}

function updateVersion() {
    cockpit.spawn(["cloudflared", "--version"])
        .done(function(versionOutput) {
            renderVersionDisplay(versionOutput.trim().split('\n')[0]);
            setUpdateButtonMode(true);
        })
        .fail(function(err) {
            renderVersionDisplay(null);
            setUpdateButtonMode(false);
            console.warn("cloudflared --version failed; treating as not installed:", err);
        });
}

// Fetches the latest cloudflared release tag from GitHub. Uses cockpit.spawn
// of curl rather than browser fetch because the plugin CSP restricts
// connect-src to 'self' — curl runs as a host process, outside that sandbox.
function fetchLatestVersion() {
    cockpit.spawn([
        "curl", "-fsSL", "-m", "10",
        "-H", "Accept: application/vnd.github+json",
        "-H", "User-Agent: cockpit-cloudflared-plugin",
        "https://api.github.com/repos/cloudflare/cloudflared/releases/latest"
    ], { err: "message" })
        .done(function(out) {
            try {
                var data = JSON.parse(out);
                latestVersion = parseVersionNumber(data.tag_name || data.name || '');
                // Re-render once the latest-version lookup resolves so the
                // pill appears without the user needing to refresh.
                if (currentVersionString) renderVersionDisplay(currentVersionString);
            } catch (e) {
                console.warn("Failed to parse latest release JSON:", e);
            }
        })
        .fail(function(err) {
            console.warn("Failed to fetch latest cloudflared version:", err);
        });
}

// ------------------------------------------------------------------
// Tab strip
// ------------------------------------------------------------------

function renderTabs(tunnels) {
    var strip = document.getElementById('tunnel-tabs');
    var tabsHtml = tunnels.map(function(t) {
        return '<button class="tunnel-tab" data-tab-unit="' +
            escapeHtml(t.unit) + '" type="button">' +
            escapeHtml(t.name) + '</button>';
    }).join('');
    tabsHtml += '<button class="tunnel-tab tunnel-tab-add" data-tab-add="1" type="button" title="Install a new tunnel">+ Add Tunnel</button>';
    strip.innerHTML = tabsHtml;

    strip.querySelectorAll('[data-tab-unit]').forEach(function(btn) {
        btn.addEventListener('click', function() {
            setActiveTab(btn.getAttribute('data-tab-unit'));
        });
    });
    var addBtn = strip.querySelector('[data-tab-add]');
    if (addBtn) addBtn.addEventListener('click', function() { setActiveTab(ADD_TAB); });
}

function setActiveTab(id) {
    activeTab = id;

    document.querySelectorAll('.tunnel-tab').forEach(function(tab) {
        var isUnit = tab.getAttribute('data-tab-unit') === id;
        var isAdd = id === ADD_TAB && tab.hasAttribute('data-tab-add');
        tab.classList.toggle('active', isUnit || isAdd);
    });

    document.querySelectorAll('#tunnels > .tunnel-card').forEach(function(card) {
        var matches = card.getAttribute('data-tunnel-unit') === id;
        card.style.display = matches ? '' : 'none';
    });

    var form = document.getElementById('install-form-container');
    if (form) form.style.display = (id === ADD_TAB) ? '' : 'none';

    try { localStorage.setItem('activeTab', id); } catch (e) {}
}

// ------------------------------------------------------------------
// Per-tunnel card rendering + wiring
// ------------------------------------------------------------------

function tunnelCardHtml(tunnel) {
    return '' +
        '<div class="pf-v6-c-card tunnel-card" data-tunnel-unit="' + escapeHtml(tunnel.unit) + '">' +
            '<div class="pf-v6-c-card__title">' +
                '<h2 class="pf-v6-c-card__title-text">' +
                    'Tunnel: ' + escapeHtml(tunnel.name) +
                    ' <span class="tunnel-unit-label">(' + escapeHtml(tunnel.unit) + ')</span>' +
                '</h2>' +
            '</div>' +
            '<div class="pf-v6-c-card__body">' +
                '<div data-role="status">Loading...</div>' +
                '<div data-role="stats"></div>' +
                '<div class="button-container">' +
                    '<button class="pf-v6-c-button pf-m-primary" data-role="restart-btn">Restart Tunnel</button>' +
                '</div>' +
                '<h3 class="tunnel-subheading">Traffic &amp; Services</h3>' +
                '<div data-role="services">Loading...</div>' +
                '<h3 class="tunnel-subheading">Live Logs</h3>' +
                '<button class="pf-v6-c-button pf-m-success pf-m-small autoscroll-toggle" data-role="autoscroll-toggle">Auto-scroll: ON</button>' +
                '<div data-role="log-container" class="log-container"></div>' +
            '</div>' +
        '</div>';
}

function part(cardEl, role) {
    return cardEl.querySelector('[data-role="' + role + '"]');
}

function updateTunnelStatus(cardEl, unit) {
    cockpit.spawn(["systemctl", "is-active", unit])
        .done(function(output) {
            var active = output.trim() === "active";
            part(cardEl, 'status').innerHTML = active
                ? '<dl class="pf-v6-c-description-list pf-m-horizontal">' +
                  '<dt class="pf-v6-c-description-list__term">Status</dt>' +
                  '<dd class="pf-v6-c-description-list__description">' +
                  '<span class="status-indicator-success">●</span> Tunnel Active' +
                  '</dd></dl>'
                : '<dl class="pf-v6-c-description-list pf-m-horizontal">' +
                  '<dt class="pf-v6-c-description-list__term">Status</dt>' +
                  '<dd class="pf-v6-c-description-list__description">' +
                  '<span class="status-indicator-danger">●</span> Tunnel Inactive' +
                  '</dd></dl>';

            if (active) {
                getConnections(cardEl, unit);
                getServices(cardEl, unit);
            } else {
                part(cardEl, 'stats').innerHTML = '';
                part(cardEl, 'services').innerHTML = '<div class="no-traffic-message">Tunnel is not running</div>';
            }
        })
        .fail(function(err) {
            console.error("Failed to check status for", unit, err);
            part(cardEl, 'status').innerHTML =
                '<dl class="pf-v6-c-description-list pf-m-horizontal">' +
                '<dt class="pf-v6-c-description-list__term">Status</dt>' +
                '<dd class="pf-v6-c-description-list__description">' +
                '<span class="status-indicator-danger">●</span> Service Not Found' +
                '</dd></dl>';
            part(cardEl, 'stats').innerHTML = '';
            part(cardEl, 'services').innerHTML = '<div class="no-traffic-message">Service not found</div>';
        });
}

function getConnections(cardEl, unit) {
    cockpit.spawn(["journalctl", "-u", unit, "--since", "10 minutes ago", "-n", "500", "--no-pager"])
        .done(function(output) {
            var registered = (output.match(/Registered tunnel connection/g) || []).length;
            var connections = (output.match(/Connection [a-f0-9-]+ registered/g) || []).length;
            var requests = (output.match(/(\d+) requests|request to/gi) || []).length;
            var errors = (output.match(/level=error|ERR |error:/gi) || []).length;
            var warnings = (output.match(/level=warning|WRN |warning:/gi) || []).length;
            var totalConnections = Math.max(registered, connections);

            part(cardEl, 'stats').innerHTML =
                '<div class="stat-container">' +
                '<div class="stat">' +
                '<div class="stat-label">Connections (10min)</div>' +
                '<div class="stat-value">' + totalConnections + '</div>' +
                '</div>' +
                '<div class="stat">' +
                '<div class="stat-label">Requests (10min)</div>' +
                '<div class="stat-value">' + requests + '</div>' +
                '</div>' +
                '<div class="stat">' +
                '<div class="stat-label">Errors (10min)</div>' +
                '<div class="stat-value">' + errors + '</div>' +
                '</div>' +
                '<div class="stat">' +
                '<div class="stat-label">Warnings (10min)</div>' +
                '<div class="stat-value">' + warnings + '</div>' +
                '</div>' +
                '</div>';
        })
        .fail(function(err) {
            console.error("Failed to get connection stats for", unit, err);
            part(cardEl, 'stats').innerHTML = '<div class="no-traffic-message">Unable to read logs</div>';
        });
}

function getServices(cardEl, unit) {
    cockpit.spawn(["journalctl", "-u", unit, "--since", "1 hour ago", "-n", "1000", "--no-pager"])
        .done(function(output) {
            var services = [];
            var patterns = [
                /dest=https?:\/\/([^\s\/:]+(?::\d+)?)/g,
                /originService=([^\s]+)/g,
                /proxying to ([^\s]+)/gi,
                /url=https?:\/\/([^\s\/]+)/g,
                /host[:\s]+([^\s]+\.[^\s]+)/gi,
                /http:\/\/([^\s:\/]+(?::\d+)?)/g
            ];

            patterns.forEach(function(pattern) {
                var matches = output.match(pattern) || [];
                matches.forEach(function(m) {
                    var service = m.replace(/dest=|originService=|proxying to |url=|host[:\s]+|https?:\/\//gi, '').trim();
                    if (service && service.length > 0 && services.indexOf(service) === -1) {
                        services.push(service);
                    }
                });
            });

            if (services.length > 0) {
                var html = services.map(function(s) {
                    return '<div class="service-item">● ' + escapeHtml(s) + '</div>';
                }).join('');
                part(cardEl, 'services').innerHTML = '<div class="service-list">' + html + '</div>';
            } else {
                part(cardEl, 'services').innerHTML =
                    '<div class="no-traffic-message">No services detected in logs. Check if tunnel is routing traffic.</div>';
            }
        })
        .fail(function(err) {
            console.error("Failed to get services for", unit, err);
            part(cardEl, 'services').innerHTML =
                '<div class="no-traffic-message">Unable to read service logs</div>';
        });
}

function updateLogs(cardEl, unit) {
    cockpit.spawn(["journalctl", "-u", unit, "-n", "100", "--no-pager"])
        .done(function(output) {
            var lines = output.split('\n').filter(function(l) { return l.trim(); });
            var container = part(cardEl, 'log-container');

            container.innerHTML = lines.map(function(line) {
                var className = 'log-line';
                if (line.match(/level=error|ERR |error:/i)) className += ' log-error';
                else if (line.match(/level=warning|WRN |warning:/i)) className += ' log-warn';
                else if (line.match(/level=info|INF |info:/i)) className += ' log-info';
                return '<div class="' + className + '">' + escapeHtml(line) + '</div>';
            }).reverse().join('');

            if (cardEl._autoScroll !== false) {
                container.scrollTop = 0;
            }
        })
        .fail(function(err) {
            console.error("Failed to get logs for", unit, err);
            part(cardEl, 'log-container').innerHTML = '<div class="log-error">Unable to read logs</div>';
        });
}

function restartTunnel(cardEl, unit) {
    var btn = part(cardEl, 'restart-btn');
    btn.disabled = true;
    btn.textContent = 'Restarting...';

    cockpit.spawn(["systemctl", "restart", unit], {
        superuser: "require",
        err: "message"
    })
        .done(function() {
            showNotification(unit + ' restarted successfully', 'success');
            setTimeout(function() {
                updateTunnelStatus(cardEl, unit);
                updateLogs(cardEl, unit);
                btn.disabled = false;
                btn.textContent = 'Restart Tunnel';
            }, 2000);
        })
        .fail(function(err) {
            showNotification('Failed to restart ' + unit + ': ' + err, 'danger');
            btn.disabled = false;
            btn.textContent = 'Restart Tunnel';
            console.error("Restart failed for", unit, err);
        });
}

function wireCard(cardEl) {
    var unit = cardEl.getAttribute('data-tunnel-unit');

    part(cardEl, 'restart-btn').addEventListener('click', function() {
        restartTunnel(cardEl, unit);
    });

    var autoBtn = part(cardEl, 'autoscroll-toggle');
    var prefKey = 'autoScroll:' + unit;
    cardEl._autoScroll = true;
    try {
        if (localStorage.getItem(prefKey) === 'false') {
            cardEl._autoScroll = false;
            autoBtn.textContent = 'Auto-scroll: OFF';
            autoBtn.classList.remove('pf-m-success');
            autoBtn.classList.add('pf-m-danger');
        }
    } catch (e) {
        console.warn("Could not load auto-scroll preference:", e);
    }

    autoBtn.addEventListener('click', function() {
        cardEl._autoScroll = !cardEl._autoScroll;
        this.textContent = cardEl._autoScroll ? 'Auto-scroll: ON' : 'Auto-scroll: OFF';
        if (cardEl._autoScroll) {
            this.classList.remove('pf-m-danger');
            this.classList.add('pf-m-success');
        } else {
            this.classList.remove('pf-m-success');
            this.classList.add('pf-m-danger');
        }
        try {
            localStorage.setItem(prefKey, cardEl._autoScroll ? 'true' : 'false');
        } catch (e) {
            console.warn("Could not save auto-scroll preference:", e);
        }
    });
}

// ------------------------------------------------------------------
// Install form (the "+ Add Tunnel" tab)
// ------------------------------------------------------------------

function installFormHtml() {
    return '' +
        '<div class="pf-v6-c-card tunnel-card" id="install-form-container">' +
            '<div class="pf-v6-c-card__title">' +
                '<h2 class="pf-v6-c-card__title-text">Install a New Tunnel</h2>' +
            '</div>' +
            '<div class="pf-v6-c-card__body">' +
                '<div class="form-field">' +
                    '<label for="install-name">Tunnel name</label>' +
                    '<input type="text" id="install-name" placeholder="e.g. prod, staging" autocomplete="off">' +
                    '<div class="form-hint">Letters, digits, underscores, hyphens. Used as the systemd unit name: <code>cloudflared-&lt;name&gt;.service</code></div>' +
                '</div>' +
                '<div class="form-field">' +
                    '<label for="install-token">Tunnel token</label>' +
                    '<textarea id="install-token" placeholder="Paste the whole install command from the Cloudflare Zero Trust dashboard — the app strips the command and keeps just the token" autocomplete="off" spellcheck="false" rows="3"></textarea>' +
                    '<div class="form-hint">Paste the full command (e.g. <code>sudo cloudflared service install eyJ...</code>). The app removes the leading command using prefixes from <code>token-prefixes.txt</code>, falling back to the last whitespace-separated chunk.</div>' +
                    '<div id="token-preview" class="token-preview" aria-live="polite"></div>' +
                '</div>' +
                '<div class="button-container">' +
                    '<button class="pf-v6-c-button pf-m-primary" id="install-submit">Install Tunnel</button>' +
                    '<button class="pf-v6-c-button pf-m-secondary" id="install-cancel">Cancel</button>' +
                '</div>' +
                '<div id="install-progress" aria-live="polite"></div>' +
            '</div>' +
        '</div>';
}

function buildUnitContent(name, token, binaryPath) {
    return '' +
        '[Unit]\n' +
        'Description=Cloudflare Tunnel (' + name + ')\n' +
        'After=network.target\n' +
        '\n' +
        '[Service]\n' +
        'TimeoutStartSec=0\n' +
        'Type=simple\n' +
        'ExecStart=' + binaryPath + ' --no-autoupdate tunnel run --token ' + token + '\n' +
        'Restart=on-failure\n' +
        'RestartSec=5s\n' +
        'User=root\n' +
        '\n' +
        '[Install]\n' +
        'WantedBy=multi-user.target\n';
}

function setInstallProgress(kind, message) {
    var el = document.getElementById('install-progress');
    if (!el) return;
    if (!kind) { el.innerHTML = ''; return; }
    el.innerHTML = '<div class="pf-v6-c-alert pf-m-' + kind + '">' +
                   '<div class="pf-v6-c-alert__title">' + escapeHtml(message) + '</div></div>';
}

function installFailed(err, submitBtn) {
    var msg = err && err.message ? err.message : String(err);
    setInstallProgress('danger', 'Install failed: ' + msg);
    submitBtn.disabled = false;
    submitBtn.textContent = 'Install Tunnel';
    console.error("Install failed:", err);
}

function installTunnel() {
    var nameInput = document.getElementById('install-name');
    var tokenInput = document.getElementById('install-token');
    var submitBtn = document.getElementById('install-submit');

    var name = (nameInput.value || '').trim();
    var token = cleanToken(tokenInput.value);

    if (!cloudflaredInstalled) {
        setInstallProgress('danger', 'cloudflared is not installed on this host. Click "Install Cloudflared" in the top-right first.');
        return;
    }
    if (!/^[a-zA-Z0-9_-]{1,48}$/.test(name)) {
        setInstallProgress('danger', 'Name must be 1-48 characters: letters, digits, underscores, hyphens.');
        return;
    }
    // Conservative: JWT/base64 token chars only. Prevents malformed unit files.
    if (!/^[A-Za-z0-9+/=._-]+$/.test(token)) {
        setInstallProgress('danger', 'Could not extract a valid token. Paste the full install command from the Cloudflare dashboard.');
        return;
    }
    if (token.length < 20) {
        setInstallProgress('danger', 'Extracted token looks too short. Paste the full command from the Cloudflare dashboard.');
        return;
    }

    var unit = 'cloudflared-' + name + '.service';
    var unitPath = '/etc/systemd/system/' + unit;

    if (renderedUnits.indexOf(unit) !== -1) {
        setInstallProgress('danger', 'A tunnel named "' + name + '" already exists.');
        return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Installing...';
    setInstallProgress('info', 'Locating cloudflared binary…');

    // Detect the cloudflared binary path so the unit's ExecStart works
    // regardless of package-manager vs manual-install layout.
    cockpit.spawn(["which", "cloudflared"], { err: "message" })
        .done(function(whichOutput) {
            var binaryPath = whichOutput.trim().split('\n')[0];
            if (!binaryPath || binaryPath.charAt(0) !== '/') {
                installFailed('Could not locate cloudflared binary (which returned: "' +
                              whichOutput.trim() + '")', submitBtn);
                return;
            }

            setInstallProgress('info', 'Writing unit file…');

            // cockpit.file avoids shell escaping concerns with the token.
            cockpit.file(unitPath, { superuser: "require" })
                .replace(buildUnitContent(name, token, binaryPath))
                .done(function() {
                    setInstallProgress('info', 'Reloading systemd…');
                    cockpit.spawn(["systemctl", "daemon-reload"], {
                        superuser: "require", err: "message"
                    })
                    .done(function() {
                        setInstallProgress('info', 'Enabling and starting tunnel…');
                        cockpit.spawn(["systemctl", "enable", "--now", unit], {
                            superuser: "require", err: "message"
                        })
                        .done(function() {
                            showNotification('Tunnel "' + name + '" installed and started', 'success');
                            submitBtn.disabled = false;
                            submitBtn.textContent = 'Install Tunnel';
                            nameInput.value = '';
                            tokenInput.value = '';
                            updateTokenPreview();
                            setInstallProgress(null);

                            // Rediscover, re-render tabs, and switch to the new tunnel.
                            tunnelDiscovery.findTunnels(function(tunnels) {
                                renderTunnels(tunnels, { preferActive: unit });
                            }, function(err) {
                                console.error("Post-install discovery failed:", err);
                            });
                        })
                        .fail(function(err) { installFailed(err, submitBtn); });
                    })
                    .fail(function(err) { installFailed(err, submitBtn); });
                })
                .fail(function(err) { installFailed(err, submitBtn); });
        })
        .fail(function(err) { installFailed(err, submitBtn); });
}

function updateTokenPreview() {
    var tokenInput = document.getElementById('install-token');
    var preview = document.getElementById('token-preview');
    if (!tokenInput || !preview) return;

    var raw = tokenInput.value || '';
    if (!raw.trim()) {
        preview.textContent = '';
        preview.className = 'token-preview';
        return;
    }

    var extracted = cleanToken(raw);
    if (!extracted) {
        preview.textContent = 'Could not detect a token in the paste.';
        preview.className = 'token-preview token-preview-empty';
        return;
    }

    var stripped = raw.trim() !== extracted;
    var short = extracted.length > 24
        ? extracted.slice(0, 12) + '…' + extracted.slice(-8)
        : extracted;
    preview.textContent = (stripped ? 'Detected token: ' : 'Token looks raw: ') +
                          short + '  (' + extracted.length + ' chars)';
    preview.className = 'token-preview token-preview-ok';
}

function wireInstallForm() {
    var submit = document.getElementById('install-submit');
    var cancel = document.getElementById('install-cancel');
    var tokenInput = document.getElementById('install-token');

    if (submit) submit.addEventListener('click', installTunnel);
    if (cancel) {
        cancel.addEventListener('click', function() {
            document.getElementById('install-name').value = '';
            document.getElementById('install-token').value = '';
            updateTokenPreview();
            setInstallProgress(null);
            // Jump to the first tunnel if there is one, else stay on + tab.
            if (renderedUnits.length > 0) setActiveTab(renderedUnits[0]);
        });
    }
    if (tokenInput) {
        tokenInput.addEventListener('input', updateTokenPreview);
    }
}

// ------------------------------------------------------------------
// Update cloudflared binary (shared) — restarts every discovered unit
// ------------------------------------------------------------------

function restartAllDiscoveredUnits(done) {
    var units = renderedUnits.slice();
    if (units.length === 0) { done(); return; }
    var remaining = units.length;
    units.forEach(function(unit) {
        cockpit.spawn(["systemctl", "restart", unit], {
            superuser: "require",
            err: "message"
        }).always(function() {
            if (--remaining === 0) done();
        });
    });
}

// Fresh-install path: cloudflared isn't on the box yet. Downloads the
// official binary for the host's architecture and drops it at
// /usr/local/bin/cloudflared. No systemd service is touched — there's
// nothing to restart.
function installCloudflaredBinary() {
    var btn = document.getElementById('update-btn');
    btn.disabled = true;
    btn.textContent = 'Installing...';

    showNotification('Detecting architecture…', 'info');

    detectArch(function(arch) {
        showNotification('Downloading cloudflared (linux-' + arch + ')…', 'info');
        downloadCloudflaredBinary(arch,
            function() {
                showNotification('cloudflared installed. You can now add a tunnel.', 'success');
                setTimeout(function() {
                    // Re-detect — on success this flips the button back to "Update".
                    updateVersion();
                    btn.disabled = false;
                }, 1000);
            },
            function(err) {
                showNotification('Install failed: ' + err, 'danger');
                btn.disabled = false;
                btn.textContent = 'Install Cloudflared';
                console.error("Install failed:", err);
            }
        );
    }, function(err) {
        showNotification(String(err), 'danger');
        btn.disabled = false;
        btn.textContent = 'Install Cloudflared';
    });
}

function handleUpdateButtonClick() {
    if (cloudflaredInstalled) updateCloudflared();
    else installCloudflaredBinary();
}

function updateCloudflared() {
    var btn = document.getElementById('update-btn');
    btn.disabled = true;
    btn.textContent = 'Updating...';

    showNotification('Checking installation method...', 'info');

    cockpit.spawn(["test", "-f", "/usr/local/etc/cloudflared/.installedFromPackageManager"], {
        err: "ignore"
    })
        .done(function() {
            showNotification('Updating via package manager...', 'info');
            // Dispatch to whichever package manager this distro has. The
            // --only-upgrade / upgrade semantics differ per tool, so each
            // branch uses the idiomatic invocation.
            cockpit.spawn([
                "bash", "-c",
                "set -e; " +
                "if command -v apt-get >/dev/null 2>&1; then " +
                "  apt-get update && apt-get install --only-upgrade -y cloudflared; " +
                "elif command -v dnf >/dev/null 2>&1; then " +
                "  dnf upgrade -y cloudflared; " +
                "elif command -v yum >/dev/null 2>&1; then " +
                "  yum update -y cloudflared; " +
                "elif command -v zypper >/dev/null 2>&1; then " +
                "  zypper --non-interactive update cloudflared; " +
                "else " +
                "  echo 'No supported package manager (apt-get, dnf, yum, zypper) found' >&2; " +
                "  exit 1; " +
                "fi"
            ], { superuser: "require", err: "message" })
                .done(function() {
                    showNotification('Updated successfully! Restarting tunnels...', 'success');
                    restartAfterUpdate(btn);
                })
                .fail(function(err) {
                    showNotification('Package update failed: ' + err, 'danger');
                    btn.disabled = false;
                    btn.textContent = 'Update Cloudflared';
                    console.error("Update failed:", err);
                });
        })
        .fail(function() {
            showNotification('Detecting architecture…', 'info');
            detectArch(function(arch) {
                showNotification('Downloading cloudflared (linux-' + arch + ')…', 'info');
                downloadCloudflaredBinary(arch,
                    function() {
                        showNotification('Binary updated! Restarting tunnels...', 'success');
                        restartAfterUpdate(btn);
                    },
                    function(err) {
                        showNotification('Binary update failed: ' + err, 'danger');
                        btn.disabled = false;
                        btn.textContent = 'Update Cloudflared';
                        console.error("Update failed:", err);
                    }
                );
            }, function(err) {
                showNotification(String(err), 'danger');
                btn.disabled = false;
                btn.textContent = 'Update Cloudflared';
            });
        });
}

function restartAfterUpdate(btn) {
    restartAllDiscoveredUnits(function() {
        setTimeout(function() {
            updateVersion();
            refreshAllCards();
            btn.disabled = false;
            btn.textContent = 'Update Cloudflared';
        }, 2000);
    });
}

// ------------------------------------------------------------------
// Render / refresh orchestration
// ------------------------------------------------------------------

function sameUnitSet(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

function renderTunnels(tunnels, opts) {
    opts = opts || {};
    var container = document.getElementById('tunnels');

    var cardsHtml = tunnels.map(tunnelCardHtml).join('');
    container.innerHTML = cardsHtml + installFormHtml();
    renderedUnits = tunnels.map(function(t) { return t.unit; });

    tunnels.forEach(function(tunnel) {
        var card = container.querySelector(
            '[data-tunnel-unit="' + tunnel.unit.replace(/"/g, '\\"') + '"]');
        if (!card) return;
        wireCard(card);
        updateTunnelStatus(card, tunnel.unit);
        updateLogs(card, tunnel.unit);
    });
    wireInstallForm();

    renderTabs(tunnels);

    // Decide which tab to activate:
    //   1. caller-provided preferActive (e.g. unit just installed)
    //   2. previously active tab if still valid
    //   3. first tunnel
    //   4. + Add Tunnel (when no tunnels exist)
    var saved = null;
    try { saved = localStorage.getItem('activeTab'); } catch (e) {}
    var want = opts.preferActive || activeTab || saved;

    var valid = want === ADD_TAB ||
                renderedUnits.indexOf(want) !== -1;

    if (valid && want) {
        setActiveTab(want);
    } else if (renderedUnits.length > 0) {
        setActiveTab(renderedUnits[0]);
    } else {
        setActiveTab(ADD_TAB);
    }
}

function refreshAllCards() {
    var cards = document.querySelectorAll('#tunnels .tunnel-card[data-tunnel-unit]');
    cards.forEach(function(card) {
        var unit = card.getAttribute('data-tunnel-unit');
        updateTunnelStatus(card, unit);
        updateLogs(card, unit);
    });
}

function rediscoverAndMaybeRender() {
    tunnelDiscovery.findTunnels(
        function(tunnels) {
            var units = tunnels.map(function(t) { return t.unit; }).sort();
            if (sameUnitSet(units, renderedUnits.slice().sort())) {
                refreshAllCards();
            } else {
                renderTunnels(tunnels);
            }
        },
        function(err) {
            console.error("Discovery failed:", err);
            refreshAllCards();
        }
    );
}

function refreshAll() {
    updateVersion();
    rediscoverAndMaybeRender();
}

// ------------------------------------------------------------------
// Init
// ------------------------------------------------------------------

window.addEventListener('load', function() {
    document.getElementById('refresh-btn').addEventListener('click', refreshAll);
    document.getElementById('update-btn').addEventListener('click', handleUpdateButtonClick);

    loadTokenPrefixes();
    fetchLatestVersion();
    updateVersion();

    tunnelDiscovery.findTunnels(
        function(tunnels) { renderTunnels(tunnels); },
        function(err) {
            console.error("Discovery failed:", err);
            document.getElementById('tunnels').innerHTML =
                '<div class="pf-v6-c-card"><div class="pf-v6-c-card__body">' +
                'Failed to discover tunnels: ' + escapeHtml(String(err)) +
                '</div></div>' + installFormHtml();
            wireInstallForm();
            renderTabs([]);
            setActiveTab(ADD_TAB);
        }
    );

    // Periodic refresh. Rediscovers so newly installed tunnels appear without
    // requiring a manual page reload.
    setInterval(refreshAll, 10000);
});
