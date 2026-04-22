// Cloudflare Tunnel auto-discovery.
//
// Scans loaded systemd service units and keeps only the ones whose ExecStart
// actually invokes the cloudflared binary. Unit naming can be anything
// (cloudflared.service, cloudflared-prod.service, cloudflared@foo.service,
// my-tunnel.service, ...) — we match on what the unit runs, not what it's
// called.
//
// Exposes window.tunnelDiscovery.findTunnels(onSuccess, onError).
// onSuccess receives [{ unit, name }, ...] where `name` is a human-readable
// tunnel name extracted from the ExecStart args (falls back to the unit name).

(function () {
    'use strict';

    var cockpit = window.cockpit;

    // "cloudflared [flags] tunnel run <name>" — pull <name>.
    // Also handle "--config /etc/cloudflared/<name>.yml" as a fallback.
    function parseTunnelName(execStart, unitName) {
        var argvMatch = execStart.match(/argv\[\]=([^;}]+)/);
        var argStr = argvMatch ? argvMatch[1] : execStart;
        var args = argStr.trim().split(/\s+/);

        for (var i = 0; i < args.length - 2; i++) {
            if (args[i] === 'tunnel' && args[i + 1] === 'run') {
                var next = args[i + 2];
                if (next && next.charAt(0) !== '-') return next;
            }
        }

        for (var j = 0; j < args.length - 1; j++) {
            if (args[j] === '--config' || args[j] === '-c') {
                var cfg = args[j + 1] || '';
                var base = cfg.split('/').pop().replace(/\.ya?ml$/i, '');
                if (base) return base;
            }
        }

        return unitName.replace(/\.service$/, '');
    }

    function execStartMentionsCloudflared(execStart) {
        // systemctl renders ExecStart as:
        //   { path=/usr/bin/cloudflared ; argv[]=/usr/bin/cloudflared ... ; ... }
        // Match either the path= or a bare token.
        return /(^|[\s=\/])cloudflared(\s|$)/.test(execStart);
    }

    // Parse `systemctl show` output. Multiple units are separated by a blank
    // line; each unit is a block of KEY=VALUE lines.
    function parseShowRecords(output) {
        return output.split(/\n\n+/).map(function (block) {
            var rec = {};
            block.split('\n').forEach(function (line) {
                var eq = line.indexOf('=');
                if (eq > 0) rec[line.slice(0, eq)] = line.slice(eq + 1);
            });
            return rec;
        });
    }

    function findTunnels(onSuccess, onError) {
        cockpit.spawn(
            ["systemctl", "list-units", "--type=service", "--all",
             "--no-legend", "--plain", "--no-pager"],
            { err: "message" }
        )
        .done(function (listOutput) {
            // First column of each line is the unit name.
            var candidates = listOutput.split('\n')
                .map(function (l) { return l.trim().split(/\s+/)[0]; })
                .filter(function (u) { return u && /\.service$/.test(u); })
                // Narrow to plausible candidates so we don't `systemctl show`
                // every service on the box. If a user names their unit
                // something exotic we can revisit.
                .filter(function (u) { return /cloudflared|tunnel/i.test(u); });

            if (candidates.length === 0) {
                onSuccess([]);
                return;
            }

            var showArgs = ["systemctl", "show",
                            "--property=Id", "--property=ExecStart"]
                           .concat(candidates);

            cockpit.spawn(showArgs, { err: "message" })
                .done(function (showOutput) {
                    var tunnels = [];
                    parseShowRecords(showOutput).forEach(function (rec) {
                        var unit = rec.Id;
                        var execStart = rec.ExecStart || '';
                        if (!unit || !execStart) return;
                        if (!execStartMentionsCloudflared(execStart)) return;
                        tunnels.push({
                            unit: unit,
                            name: parseTunnelName(execStart, unit)
                        });
                    });
                    // Stable order: sort by unit name.
                    tunnels.sort(function (a, b) {
                        return a.unit.localeCompare(b.unit);
                    });
                    onSuccess(tunnels);
                })
                .fail(function (err) { onError(err); });
        })
        .fail(function (err) { onError(err); });
    }

    window.tunnelDiscovery = { findTunnels: findTunnels };
})();
