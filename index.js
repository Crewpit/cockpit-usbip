(function () {
    "use strict";

    var MENU = {
        label: "USB/IP",
        items: [
            { label: "Client", path: "/", pane: "pane-client", onShow: showClient, onHide: hideClient },
            { label: "Server", path: "/server", pane: "pane-server", onShow: showServer, onHide: hideServer },
        ],
    };

    var BUSID_RE = /^[0-9]+-[0-9.]+$/;
    var HOST_RE = /^[A-Za-z0-9\[][A-Za-z0-9._:\-\]]*$/;

    function byId(id) { return document.getElementById(id) }

    function label(text, color) {
        return App.el("span", { class: "pf-v6-c-label" + (color ? " pf-m-" + color : "") }, [
            App.el("span", { class: "pf-v6-c-label__content" }, [
                App.el("span", { class: "pf-v6-c-label__text", text: text }),
            ]),
        ]);
    }

    function setLabel(id, text, color) {
        byId(id).replaceChildren(label(text, color));
    }

    var permission = cockpit.permission({ admin: true });

    // allowed is null until Cockpit has checked, so only an explicit false locks the page.
    function isAdmin() { return permission.allowed !== false }

    // `admin` marks buttons that need root: they are disabled without it.
    function actionButton(text, variant, onClick, admin) {
        var b = App.el("button", { class: "pf-v6-c-button pf-m-" + variant + " pf-m-small", type: "button", text: text });
        if (admin && !isAdmin())
            b.disabled = true;
        b.addEventListener("click", function () { onClick(b) });
        return b;
    }

    function errText(ex) {
        if (ex.problem === "timeout")
            return "Timed out waiting for the command to finish.";
        if (ex.problem === "not-found")
            return "Command not found: is the usbip package installed?";
        return ex.message || ex.problem || "unknown error";
    }

    // cockpit.spawn that rejects with problem "timeout" after `ms`.
    function spawnTimeout(argv, opts, ms) {
        var proc = cockpit.spawn(argv, opts);
        var timer = window.setTimeout(function () { proc.close("timeout") }, ms);
        function done() { window.clearTimeout(timer) }
        proc.then(done, done);
        return proc;
    }

    // Built-in modules are not listed in /proc/modules, so "not loaded" is advisory.
    function moduleLoaded(name) {
        return cockpit.file("/proc/modules").read().then(function (text) {
            return (text || "").split("\n").some(function (l) { return l.split(" ")[0] === name });
        }).catch(function () { return false });
    }

    // "Load at Boot" switch backed by /etc/modules-load.d/. On: write the file
    // and modprobe now. Off: remove it and try to unload (failure is a warning).
    function moduleControl(opts) {
        var sw = byId(opts.toggle);
        var modName = opts.name.replace(/_/g, "-");
        var confPath = "/etc/modules-load.d/cockpit-usbip-" + modName + ".conf";
        var conf = cockpit.file(confPath, { superuser: "require" });
        var confRead = cockpit.file(confPath); // world-readable: no privilege prompt while polling

        function refresh() {
            return Promise.all([moduleLoaded(opts.name), confRead.read().catch(function () { return null })]).then(function (r) {
                setLabel(opts.label, r[0] ? "Loaded (" + opts.name + ")" : "Not loaded (" + opts.name + ")", r[0] ? "green" : "orange");
                sw.checked = r[1] !== null && r[1] !== undefined;
                applyPermission();
            });
        }

        sw.addEventListener("change", function () {
            var enable = sw.checked;
            sw.disabled = true;
            var work = enable
                ? conf.replace(modName + "\n").then(function () {
                    return App.run(["modprobe", modName], {
                        superuser: "require", failure: "Couldn't load " + opts.name,
                        success: opts.name + " will load at every boot",
                    });
                })
                : conf.replace(null).then(function () {
                    return cockpit.spawn(["modprobe", "-r", modName], { superuser: "require", err: "message" })
                            .then(function () { App.alerts.toast("success", opts.name + " will no longer load at boot") },
                                  function (ex) {
                                      App.alerts.toast("warning", opts.name + " will no longer load at boot",
                                                       { description: "It is still loaded now: " + errText(ex) });
                                  });
                });
            work.catch(function (ex) {
                App.alerts.toast("danger", "Couldn't change boot loading of " + opts.name, { description: errText(ex) });
            }).then(function () {
                sw.disabled = false;
                return refresh();
            });
        });
        return refresh;
    }

    function autoRefresh(prefix, fetchFn) {
        var sw = byId(prefix + "-auto");
        var hint = byId(prefix + "-auto-hint");
        var poller = null;
        function stop() {
            if (poller)
                poller.stop();
            poller = null;
        }
        function apply() {
            stop();
            if (sw.checked)
                poller = App.poll(fetchFn, 5000);
            else
                fetchFn();
            hint.textContent = sw.checked ? "Refreshing every 5 seconds while this page is open." : "Paused. Use Refresh to update.";
        }
        sw.addEventListener("change", apply);
        byId(prefix + "-refresh-btn").addEventListener("click", fetchFn);
        return { start: apply, stop: stop };
    }

    function stamp(id) {
        byId(id).textContent = "Updated " + new Date().toLocaleTimeString();
    }

    // Server: usbipd + usbip bind/unbind

    var serverTable = null;
    var serverOpts = null; // emptyText is read at render time, so it can change

    // " - busid 1-1 (0781:5581)" followed by "   Vendor : Product (0781:5581)"
    function parseLocal(out) {
        var devs = [];
        var cur = null;
        out.split("\n").forEach(function (line) {
            var m = line.match(/^\s*-\s*busid\s+([0-9.\-]+)\s+\(([0-9a-fA-F]{4}:[0-9a-fA-F]{4})\)/);
            if (m) {
                cur = { busid: m[1], id: m[2], desc: "", bound: false };
                devs.push(cur);
            } else if (cur && !cur.desc && line.trim()) {
                cur.desc = line.trim().replace(/\s*\([0-9a-fA-F]{4}:[0-9a-fA-F]{4}\)\s*$/, "");
            }
        });
        return devs.filter(function (d) { return BUSID_RE.test(d.busid) });
    }

    // Shared = bound to the usbip-host driver.
    function markBound(devs) {
        if (!devs.length)
            return Promise.resolve(devs);
        var script = 'for b in "$@"; do d=$(readlink "/sys/bus/usb/devices/$b/driver" 2>/dev/null); echo "$b ${d##*/}"; done';
        return cockpit.spawn(["sh", "-c", script, "sh"].concat(devs.map(function (d) { return d.busid })), { err: "message" })
                .then(function (out) {
                    var drivers = {};
                    out.trim().split("\n").forEach(function (l) {
                        var p = l.split(" ");
                        drivers[p[0]] = p[1];
                    });
                    devs.forEach(function (d) { d.bound = drivers[d.busid] === "usbip-host" });
                    return devs;
                });
    }

    function fetchServerDevices() {
        return spawnTimeout(["usbip", "list", "-l"], { err: "message" }, 15000)
                .then(function (out) { return markBound(parseLocal(out)) })
                .then(function (devs) {
                    App.alerts.inline("server-alert");
                    serverOpts.emptyText = "No USB devices found.";
                    serverTable.setRows(devs);
                    stamp("server-updated");
                })
                .catch(function (ex) {
                    serverOpts.emptyText = "No data.";
                    serverTable.setRows([]);
                    App.alerts.inline("server-alert", "danger", "Couldn't list USB devices", errText(ex));
                });
    }

    function toggleBind(button, dev) {
        var verb = dev.bound ? "unbind" : "bind";
        App.run(["usbip", verb, "-b", dev.busid], {
            superuser: "require", button: button, busyLabel: dev.bound ? "Unbinding..." : "Binding...",
            success: (dev.bound ? "Stopped sharing " : "Sharing ") + dev.busid,
            failure: "Couldn't " + verb + " " + dev.busid,
        }).then(fetchServerDevices);
    }

    var daemonRunning = false;

    function refreshDaemon() {
        return cockpit.spawn(["pgrep", "-x", "usbipd"], { err: "ignore" })
                .then(function () { return true }, function () { return false })
                .then(function (running) {
                    daemonRunning = running;
                    setLabel("server-daemon", running ? "Running" : "Stopped", running ? "green" : "orange");
                    var btn = byId("server-daemon-btn");
                    btn.hidden = false;
                    btn.textContent = running ? "Stop Daemon" : "Start Daemon";
                    applyPermission();
                });
    }

    byId("server-daemon-btn").addEventListener("click", function () {
        var argv = daemonRunning ? ["pkill", "-x", "usbipd"] : ["usbipd", "-D"];
        App.run(argv, {
            superuser: "require", button: "server-daemon-btn", busyLabel: daemonRunning ? "Stopping..." : "Starting...",
            success: daemonRunning ? "usbipd stopped" : "usbipd started",
            failure: daemonRunning ? "Couldn't stop usbipd" : "Couldn't start usbipd",
        }).then(refreshDaemon);
    });

    var refreshServerModule = moduleControl({ name: "usbip_host", label: "server-module", toggle: "server-module-sw" });

    var serverAuto = autoRefresh("server", function () {
        refreshServerModule();
        refreshDaemon();
        return fetchServerDevices();
    });

    function showServer() {
        if (!serverTable)
            serverTable = App.table.create(serverOpts = {
                container: "server-table",
                columns: [
                    { key: "busid", label: "Bus ID" },
                    { key: "id", label: "ID", render: function (v) { return App.el("span", { class: "app-mono", text: v }) } },
                    { key: "desc", label: "Device" },
                    { key: "bound", label: "State", render: function (v) { return v ? label("Shared", "green") : label("Not shared") } },
                    {
                        key: "busid", label: "", sortable: false, render: function (v, row) {
                            return actionButton(row.bound ? "Unbind" : "Bind", row.bound ? "secondary" : "primary",
                                                function (b) { toggleBind(b, row) }, true);
                        },
                    },
                ],
                sort: { key: "busid", dir: "asc" },
                emptyText: "Loading...",
            });
        serverAuto.start();
    }

    function hideServer() { serverAuto.stop() }

    // Client: usbip list -r / attach / port / detach

    var remoteTable = null;
    var portsTable = null;
    var portsOpts = null;

    // "        1-1: Vendor : Product (0781:5581)"
    function parseRemote(out) {
        var devs = [];
        out.split("\n").forEach(function (line) {
            var m = line.match(/^\s+([0-9]+-[0-9.]+):\s*(.*)$/);
            if (m)
                devs.push({ busid: m[1], desc: m[2] });
        });
        return devs;
    }

    var queriedHost = "";

    function queryHost(host) {
        if (!HOST_RE.test(host)) {
            App.alerts.inline("client-alert", "warning", "Enter a valid server host name or IP address");
            return;
        }
        var btn = byId("client-query-btn");
        btn.disabled = true;
        btn.textContent = "Querying...";
        spawnTimeout(["usbip", "list", "-r", host], { err: "message" }, 20000)
                .then(function (out) {
                    App.alerts.inline("client-alert");
                    queriedHost = host;
                    remoteTable.setRows(parseRemote(out));
                }, function (ex) {
                    App.alerts.inline("client-alert", "danger", "Couldn't query " + host, errText(ex));
                })
                .then(function () {
                    btn.disabled = false;
                    btn.textContent = "Query";
                });
    }

    byId("client-form").addEventListener("submit", function (ev) {
        ev.preventDefault();
        queryHost(byId("client-host").value.trim());
    });

    // Network scan: nmap finds open TCP 3240, `usbip list -r` confirms it.
    // Limits: private ranges, /22 at most, rate limited, 64 hosts, 4 at a time.

    var USBIP_PORT = "3240";
    var scanTable = null;
    var scanProc = null;
    var scanActive = [];
    var scanCancelled = false;

    function parseCidr(text) {
        var m = text.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/);
        if (!m)
            return { error: "Enter an IPv4 address or CIDR, for example 192.168.1.0/24." };
        var o = m.slice(1, 5).map(Number);
        var p = m[5] === undefined ? 32 : Number(m[5]);
        if (o.some(function (n) { return n > 255 }) || p > 32)
            return { error: "That isn't a valid address." };
        if (p < 22)
            return { error: "That range is too large. Use /22 (1024 addresses) or smaller." };
        var priv = o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168) ||
                   (o[0] === 100 && o[1] >= 64 && o[1] <= 127) || o[0] === 127 || (o[0] === 169 && o[1] === 254);
        if (!priv)
            return { error: "Only private ranges (10/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16, 127/8) can be scanned." };
        return { cidr: o.join(".") + "/" + p };
    }

    function setScanBusy(busy) {
        byId("scan-btn").disabled = busy;
        byId("scan-cidr").disabled = busy;
        byId("scan-cancel-btn").hidden = !busy;
    }

    function scanStatus(text) { byId("scan-status").textContent = text }

    // "Host: 10.0.0.5 ()\tPorts: 3240/open/tcp//usbip///"
    function parseNmap(out) {
        var hosts = [];
        out.split("\n").forEach(function (line) {
            var m = line.match(/^Host:\s+(\d+\.\d+\.\d+\.\d+)\s.*Ports:\s*3240\/open\//);
            if (m)
                hosts.push(m[1]);
        });
        return hosts;
    }

    function verifyHosts(hosts) {
        var found = [];
        var next = 0;
        var done = 0;

        function worker() {
            if (scanCancelled || next >= hosts.length)
                return Promise.resolve();
            var host = hosts[next++];
            var proc = spawnTimeout(["usbip", "list", "-r", host], { err: "message" }, 8000);
            scanActive.push(proc);
            return proc.then(function (out) {
                found.push({ host: host, devices: parseRemote(out).length });
                scanTable.setRows(found.slice());
            }, function (ex) {
                if (ex.problem === "not-found")
                    throw ex;
            }).then(function () {
                scanActive.splice(scanActive.indexOf(proc), 1);
                done++;
                scanStatus("Confirming USB/IP on open hosts: " + done + " of " + hosts.length + "...");
                return worker();
            });
        }

        return Promise.all([worker(), worker(), worker(), worker()]).then(function () { return found });
    }

    byId("scan-form").addEventListener("submit", function (ev) {
        ev.preventDefault();
        var parsed = parseCidr(byId("scan-cidr").value.trim());
        if (parsed.error) {
            App.alerts.inline("scan-alert", "warning", parsed.error);
            return;
        }
        App.alerts.inline("scan-alert");
        scanCancelled = false;
        scanTable.setRows([]);
        setScanBusy(true);
        scanStatus("Scanning " + parsed.cidr + " for TCP " + USBIP_PORT + "...");

        var args = ["nmap", "-n", "-Pn", "-sT", "-p", USBIP_PORT, "--open", "--max-retries", "1",
                    "--host-timeout", "5s", "--max-rate", "100", "-oG", "-", parsed.cidr];
        scanProc = cockpit.spawn(args, { err: "message" });
        var timer = window.setTimeout(function () { scanProc.close("timeout") }, 180000);
        var openCount = 0;

        scanProc.then(function (out) {
            window.clearTimeout(timer);
            var hosts = parseNmap(out);
            openCount = hosts.length;
            if (hosts.length > 64) {
                App.alerts.inline("scan-alert", "info", "Showing the first 64 of " + hosts.length + " hosts with the port open");
                hosts = hosts.slice(0, 64);
            }
            scanProc = null;
            return verifyHosts(hosts);
        }, function (ex) {
            window.clearTimeout(timer);
            scanProc = null;
            throw ex;
        }).then(function (found) {
            scanStatus(scanCancelled ? "Scan cancelled." :
                       "Scan finished: " + plural(openCount, "host", "hosts") + " with TCP " + USBIP_PORT + " open, " +
                       plural(found.length, "confirmed USB/IP server", "confirmed USB/IP servers") + ".");
        }).catch(function (ex) {
            if (scanCancelled) {
                scanStatus("Scan cancelled.");
            } else if (ex.problem === "not-found") {
                scanStatus("");
                App.alerts.inline("scan-alert", "danger", "A required command is missing", "Install nmap and usbip on this machine.");
            } else {
                scanStatus("");
                App.alerts.inline("scan-alert", "danger", "Scan failed", errText(ex));
            }
        }).then(function () {
            scanActive = [];
            setScanBusy(false);
        });
    });

    byId("scan-cancel-btn").addEventListener("click", function () {
        scanCancelled = true;
        if (scanProc)
            scanProc.close("cancelled");
        scanActive.slice().forEach(function (p) { p.close("cancelled") });
    });

    function attachRemote(button, dev) {
        App.run(["usbip", "attach", "-r", queriedHost, "-b", dev.busid], {
            superuser: "require", button: button, busyLabel: "Attaching...",
            success: "Attached " + dev.busid + " from " + queriedHost, failure: "Couldn't attach " + dev.busid,
        }).then(fetchPorts);
    }

    // "Port 00: <Port in Use> at High Speed(480Mbps)", then the device name,
    // then "1-1 -> usbip://192.168.1.5:3240/1-1"
    function parsePorts(out) {
        var ports = [];
        var cur = null;
        out.split("\n").forEach(function (line) {
            var m = line.match(/^Port\s+(\d+):\s*<Port in Use>\s*(.*)$/);
            if (m) {
                cur = { port: Number(m[1]), speed: m[2].replace(/^at\s+/, ""), desc: "", remote: "" };
                ports.push(cur);
                return;
            }
            if (!cur)
                return;
            var r = line.match(/->\s*usbip:\/\/(\S+)/);
            if (r)
                cur.remote = r[1];
            else if (!cur.desc && line.trim() && !/->/.test(line))
                cur.desc = line.trim();
        });
        return ports;
    }

    // Exists for both module and built-in vhci_hcd, so it doubles as an "is the
    // client usable" check before running `usbip port`.
    var VHCI_STATUS = "/sys/devices/platform/vhci_hcd.0/status";

    function readVhci() {
        return cockpit.file(VHCI_STATUS, { superuser: "try" }).read().then(function (text) {
            if (text === null || text === undefined)
                return null;
            var rows = text.split("\n").slice(1).filter(function (l) { return l.trim() });
            var used = rows.filter(function (l) { return l.trim().split(/\s+/)[2] !== "004" }); // 004 = port free
            return { attached: used.length };
        }, function () { return null });
    }

    function plural(n, one, many) { return n + " " + (n === 1 ? one : many) }

    function remoteHosts(ports) {
        var seen = {};
        ports.forEach(function (p) {
            if (p.remote)
                seen[p.remote.split("/")[0].replace(/:\d+$/, "")] = true;
        });
        return Object.keys(seen).length;
    }

    // `ports` (from fetchPorts) saves a second `usbip port` call.
    function updateFooter(ports) {
        var box = byId("footer-status");
        function show(list) {
            var n = list.length;
            var strong = App.el("strong", { text: plural(n, "attached device", "attached devices") });
            box.replaceChildren(strong);
            if (n)
                box.appendChild(document.createTextNode(" from " + plural(remoteHosts(list), "remote host", "remote hosts")));
        }
        if (ports)
            return show(ports);
        return readVhci().then(function (v) {
            if (!v) {
                box.textContent = "vhci-hcd not active";
                return null;
            }
            if (!v.attached)
                return [];
            return spawnTimeout(["usbip", "port"], { err: "message", superuser: "try" }, 15000).then(parsePorts);
        }).then(function (list) { if (list) show(list) }, function () { box.textContent = "Attached devices unavailable" });
    }

    function fetchPorts() {
        return readVhci().then(function (v) {
            if (!v) {
                App.alerts.inline("client-ports-alert", "info", "The vhci-hcd driver isn't active",
                                  "Turn on Load at Boot above to load it, then attach a device.");
                portsOpts.emptyText = "No attached devices.";
                portsTable.setRows([]);
                stamp("client-updated");
                return updateFooter();
            }
            return spawnTimeout(["usbip", "port"], { err: "message", superuser: "try" }, 15000).then(function (out) {
                App.alerts.inline("client-ports-alert");
                portsOpts.emptyText = "No attached devices.";
                var ports = parsePorts(out);
                portsTable.setRows(ports);
                stamp("client-updated");
                updateFooter(ports);
            });
        }).catch(function (ex) {
            portsOpts.emptyText = "No data.";
            portsTable.setRows([]);
            App.alerts.inline("client-ports-alert", "danger", "Couldn't list attached devices", errText(ex));
        });
    }

    function detachPort(button, row) {
        App.run(["usbip", "detach", "-p", String(row.port)], {
            superuser: "require", button: button, busyLabel: "Detaching...",
            success: "Detached port " + row.port, failure: "Couldn't detach port " + row.port,
        }).then(fetchPorts);
    }

    var refreshClientModule = moduleControl({ name: "vhci_hcd", label: "client-module", toggle: "client-module-sw" });

    var clientAuto = autoRefresh("client", function () {
        refreshClientModule();
        return fetchPorts();
    });

    function applyPermission() {
        var ok = isAdmin();
        if (ok)
            App.alerts.inline("admin-notice");
        else
            App.alerts.inline("admin-notice", "warning", "Administrative access is required",
                              "You can look around, but binding, attaching, loading modules and starting the daemon are disabled. " +
                              "Turn on administrative access in Cockpit to use them.");
        ["server-daemon-btn", "server-module-sw", "client-module-sw"].forEach(function (id) {
            byId(id).disabled = !ok;
        });
    }

    permission.addEventListener("changed", function () {
        applyPermission();
        [serverTable, remoteTable, portsTable].forEach(function (t) {
            if (t)
                t.setRows(t.rows());
        });
    });

    var footerPoll = App.poll(updateFooter, 5000);

    function showClient() {
        footerPoll.stop();
        if (!remoteTable) {
            scanTable = App.table.create({
                container: "scan-table",
                columns: [
                    { key: "host", label: "Host", render: function (v) { return App.el("span", { class: "app-mono", text: v }) } },
                    { key: "devices", label: "Shared Devices", numeric: true },
                    {
                        key: "host", label: "", sortable: false, render: function (v) {
                            return actionButton("Query", "secondary", function () {
                                byId("client-host").value = v;
                                queryHost(v);
                            });
                        },
                    },
                ],
                sort: { key: "host", dir: "asc" },
                emptyText: "No scan results yet.",
            });
            remoteTable = App.table.create({
                container: "client-remote-table",
                columns: [
                    { key: "busid", label: "Bus ID" },
                    { key: "desc", label: "Device" },
                    {
                        key: "busid", label: "", sortable: false, render: function (v, row) {
                            return actionButton("Attach", "primary", function (b) { attachRemote(b, row) }, true);
                        },
                    },
                ],
                sort: { key: "busid", dir: "asc" },
                emptyText: "Query a server to list its shared devices.",
            });
            portsTable = App.table.create(portsOpts = {
                container: "client-ports-table",
                columns: [
                    { key: "port", label: "Port", numeric: true },
                    { key: "desc", label: "Device" },
                    { key: "remote", label: "Remote", render: function (v) { return App.el("span", { class: "app-mono", text: v }) } },
                    { key: "speed", label: "Speed" },
                    {
                        key: "port", label: "", sortable: false, render: function (v, row) {
                            return actionButton("Detach", "secondary", function (b) { detachPort(b, row) }, true);
                        },
                    },
                ],
                sort: { key: "port", dir: "asc" },
                emptyText: "Loading...",
            });
        }
        clientAuto.start();
    }

    function hideClient() {
        clientAuto.stop();
        footerPoll = App.poll(updateFooter, 5000);
    }


    App.menu.mount(MENU, {
        nav: "app-menu",
        startExpanded: true,
    });
}());
