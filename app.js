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

// Tracks the set of currently rendered units so rediscovery only re-renders
// when the set changes.
var renderedUnits = [];

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

function updateVersion() {
    cockpit.spawn(["cloudflared", "--version"])
        .done(function(versionOutput) {
            var version = versionOutput.trim().split('\n')[0];
            document.getElementById("version-info").textContent = version;
        })
        .fail(function(err) {
            document.getElementById("version-info").textContent = "Version unknown";
            console.error("Failed to get cloudflared version:", err);
        });
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
            cockpit.spawn([
                "bash", "-c",
                "apt-get update && apt-get install --only-upgrade -y cloudflared"
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
            showNotification('Downloading latest cloudflared binary...', 'info');
            cockpit.spawn([
                "bash", "-c",
                "curl -L --output /tmp/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && " +
                "chmod +x /tmp/cloudflared && " +
                "cp /tmp/cloudflared /usr/local/bin/cloudflared"
            ], { superuser: "require", err: "message" })
                .done(function() {
                    showNotification('Binary updated! Restarting tunnels...', 'success');
                    restartAfterUpdate(btn);
                })
                .fail(function(err) {
                    showNotification('Binary update failed: ' + err, 'danger');
                    btn.disabled = false;
                    btn.textContent = 'Update Cloudflared';
                    console.error("Update failed:", err);
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

function renderTunnels(tunnels) {
    var container = document.getElementById('tunnels');

    if (tunnels.length === 0) {
        container.innerHTML =
            '<div class="pf-v6-c-card"><div class="pf-v6-c-card__body">' +
            'No cloudflared tunnels detected. Install one with ' +
            '<code>cloudflared service install</code>.' +
            '</div></div>';
        renderedUnits = [];
        return;
    }

    container.innerHTML = tunnels.map(tunnelCardHtml).join('');
    renderedUnits = tunnels.map(function(t) { return t.unit; });

    tunnels.forEach(function(tunnel) {
        var card = container.querySelector(
            '[data-tunnel-unit="' + tunnel.unit.replace(/"/g, '\\"') + '"]');
        if (!card) return;
        wireCard(card);
        updateTunnelStatus(card, tunnel.unit);
        updateLogs(card, tunnel.unit);
    });
}

function refreshAllCards() {
    var cards = document.querySelectorAll('#tunnels .tunnel-card');
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
                // Same set — just refresh existing cards in place.
                refreshAllCards();
            } else {
                renderTunnels(tunnels);
            }
        },
        function(err) {
            console.error("Discovery failed:", err);
            // Keep existing cards; just refresh them so the page stays useful.
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
    document.getElementById('update-btn').addEventListener('click', updateCloudflared);

    updateVersion();

    tunnelDiscovery.findTunnels(
        function(tunnels) { renderTunnels(tunnels); },
        function(err) {
            console.error("Discovery failed:", err);
            document.getElementById('tunnels').innerHTML =
                '<div class="pf-v6-c-card"><div class="pf-v6-c-card__body">' +
                'Failed to discover tunnels: ' + escapeHtml(String(err)) +
                '</div></div>';
        }
    );

    // Periodic refresh. Rediscovers so newly installed tunnels appear without
    // requiring a manual page reload.
    setInterval(refreshAll, 10000);
});
