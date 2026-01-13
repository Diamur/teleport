// TelePort MVP client
(() => {
    const $ = (id) => document.getElementById(id);

    // ====== DEBUG LOGGING ======
    // Все ключевые шаги логируются в console.
    // addLine() теперь тоже дублирует вывод в console.
    const DEBUG = true;

    function _ts() {
        const d = new Date();
        const pad = (n) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
    }

    function dbg(step, data) {
        if (!DEBUG) return;
        if (typeof data === "undefined") console.log(`[TP] ${_ts()} ${step}`);
        else console.log(`[TP] ${_ts()} ${step}`, data);
    }

    function err(step, data) {
        if (!DEBUG) return;
        if (typeof data === "undefined") console.error(`[TP] ${_ts()} ${step}`);
        else console.error(`[TP] ${_ts()} ${step}`, data);
    }

    // ====== UI refs ======
    const loginView = $("loginView");
    const appView = $("appView");

    const loginInput = $("login");
    const passInput = $("password");
    const btnLogin = $("btnLogin");
    const loginError = $("loginError");

    const meEl = $("me");
    const wsDot = $("wsDot");
    const wsStateEl = $("wsState");
    const onlineInfo = $("onlineInfo");
    const usersBody = $("usersBody");
    const logEl = $("log");
    const confInfo = $("confInfo");
    const logToggle = $("logToggle");
    const remoteAudios = $("remoteAudios");

    const btnConf = $("btnConf");
    const btnHangupAll = $("btnHangupAll");
    const btnLogout = $("btnLogout");
    const incomingModal = $("incomingModal");
    const incomingFrom = $("incomingFrom");
    const acceptBtn = $("acceptBtn");
    const rejectBtn = $("rejectBtn");

    const API = "../api";

    dbg("BOOT: script loaded", {
        href: location.href,
        API,
        has: {
            loginView: !!loginView,
            appView: !!appView,
            loginInput: !!loginInput,
            passInput: !!passInput,
            btnLogin: !!btnLogin,
            btnLogout: !!btnLogout,
        },
    });

    // ---- UI helpers ----
    function addLine(text) {
        // UI log
        const div = document.createElement("div");
        div.textContent = text;
        logEl.appendChild(div);
        logEl.scrollTop = logEl.scrollHeight;

        // Console log (по просьбе — всё в консоль)
        dbg("UI", text);
    }

    function setWsState(state, ok) {
        wsStateEl.textContent = "WS: " + state;
        wsDot.className = "dot " + (ok ? "on" : "off");
        dbg("WS_STATE", { state, ok });
    }

    function setLoginError(msg) {
        loginError.textContent = msg || "";
        if (msg) err("LOGIN_ERROR_UI", msg);
        else dbg("LOGIN_ERROR_UI cleared");
    }

    function updateLogToggleLabel(isCollapsed) {
        if (!logToggle) return;
        logToggle.textContent = isCollapsed ? "Лог (показать)" : "Лог (скрыть)";
    }

    async function apiFetch(path, options = {}) {
        const url = API + path + (path.includes("?") ? "&" : "?") + "ts=" + Date.now();
        const method = (options.method || "GET").toUpperCase();
					   
					  
												   
										   
			  
		   

        dbg("API ->", { method, url, body: options.body });

        let res;
        let data;

        try {
            res = await fetch(url, {
                credentials: "include",
                ...options,
                headers: {
                    "Content-Type": "application/json",
                    ...(options.headers || {}),
                },
            });
        } catch (e) {
            err("API network error", { method, url, error: String(e) });
            throw e;
        }

        try {
            data = await res.json();
        } catch {
            data = {};
        }

        dbg("API <-", { method, url, status: res.status, ok: res.ok, data });

        if (!res.ok) {
            const msg = data && data.error ? data.error : "http_" + res.status;
            const e = new Error(msg);
            e.status = res.status;
            e.data = data;
            throw e;
        }
        return data;
    }

    // ---- Auth state ----
    let me = null;

    // ---- Presence polling ----
    let pingTimer = null;
    let usersTimer = null;
    const selectedForConf = new Set(); // logins
    let lastUsers = []; // last list from server

    async function startTimers() {
        dbg("TIMERS startTimers()");
        stopTimers();

        // ping: держим сессию живой
        pingTimer = setInterval(async () => {
            dbg("TIMER ping tick");
            try {
                await apiFetch("/ping.php", { method: "POST", body: "{}" });
                dbg("TIMER ping ok");
            } catch (e) {
                err("TIMER ping fail", { message: e.message, status: e.status, data: e.data });
            }
        }, 10_000);

        // users refresh
        usersTimer = setInterval(() => {
            dbg("TIMER users tick");
            refreshUsers();
        }, 3_000);

        await refreshUsers();
        dbg("TIMERS started");
    }

    function stopTimers() {
        dbg("TIMERS stopTimers()");
        if (pingTimer) clearInterval(pingTimer);
        if (usersTimer) clearInterval(usersTimer);
        pingTimer = null;
        usersTimer = null;
    }

    // ---- WebSocket signaling + WebRTC ----
    let ws = null;
    let wsReady = false;

    // peer connections per user
    const peers = new Map(); // login -> { pc }
    let localStream = null;
    let micHelpShown = false;
    let pendingIncomingCall = null;
    const pendingIce = new Map(); // login -> [candidate]

    function wsUrl() {
        const proto = location.protocol === "https:" ? "wss" : "ws";
        // предполагаем, что nginx/Caddy проксируют /ws -> node:3000
        return `${proto}://${location.host}/ws`;
    }

    function connectWs() {
        dbg("WS connectWs() called", { existing: !!ws, ready: wsReady });

        if (ws) {
            try {
                dbg("WS closing existing socket");
                ws.close();
            } catch (e) {
                err("WS close existing error", String(e));
            }
            ws = null;
        }

        wsReady = false;
        setWsState("подключаемся…", false);

        const url = wsUrl();
        dbg("WS connecting to", url);
        ws = new WebSocket(url);

        ws.onopen = () => {
            dbg("WS onopen");
            wsReady = true;
            setWsState("online", true);
            addLine("✅ WS подключен");
            // join
            wsSend({ type: "join", name: me });
        };

        ws.onclose = (ev) => {
            err("WS onclose", { code: ev.code, reason: ev.reason, wasClean: ev.wasClean });
            wsReady = false;
            setWsState("offline", false);
            addLine("⛔ WS отключен");
        };

        ws.onerror = (e) => {
            err("WS onerror", e);
            wsReady = false;
            setWsState("ошибка", false);
        };

        ws.onmessage = async (e) => {
            dbg("WS <- message (raw)", e.data);

            let data = null;
            try {
                data = JSON.parse(e.data);
            } catch {
                err("WS message JSON parse fail", e.data);
                return;
            }

            dbg("WS <- message (json)", data);

            if (data.type === "sys") {
                addLine("🔧 " + (data.text || ""));
                return;
            }

            if (data.type === "webrtc") {
                const p = data.payload || {};
                const from = p.from;
                if (!from) {
                    err("WEBRTC message without from", data);
                    return;
                }

                if (p.t === "offer") {
                    await onOffer(from, p.sdp);
                    return;
                }
                if (p.t === "answer") {
                    await onAnswer(from, p.sdp);
                    return;
                }
                if (p.t === "ice") {
                    await onIce(from, p.c);
                    return;
                }
                if (p.t === "hangup") {
                    if (pendingIncomingCall && pendingIncomingCall.from === from) {
                        addLine("☎️ Звонок отменён пользователем " + from);
                        pendingIncomingCall = null;
                        pendingIce.delete(from);
                        hideIncomingModal();
                    } else {
                        addLine("⛔ " + from + " завершил звонок");
                    }
                    cleanupPeer(from);
                    renderUsers(lastUsers);
                    return;
                }
                if (p.t === "reject") {
                    addLine("⛔ Звонок отклонён пользователем " + from);
                    pendingIce.delete(from);
                    cleanupPeer(from);
                    renderUsers(lastUsers);
                    return;
                }
            }
        };
    }

    function wsSend(obj) {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            dbg("WS_SEND skipped (not open)", { readyState: ws ? ws.readyState : null, obj });
            return;
        }
        dbg("WS -> send", obj);
        ws.send(JSON.stringify(obj));
    }

    function showIncomingModal(from) {
        if (!incomingModal || !incomingFrom) return;
        incomingFrom.textContent = from || "";
        incomingModal.hidden = false;
        dbg("UI showIncomingModal", { from });
    }

    function hideIncomingModal() {
        if (!incomingModal) return;
        incomingModal.hidden = true;
        if (incomingFrom) incomingFrom.textContent = "";
        dbg("UI hideIncomingModal");
    }

    async function flushPendingIce(login, pc) {
        const queued = pendingIce.get(login);
        if (!queued || queued.length === 0) return;
        dbg("RTC apply queued ICE", { login, count: queued.length });
        for (const candidate of queued) {
            try {
                // eslint-disable-next-line no-await-in-loop
                await pc.addIceCandidate(candidate);
            } catch (e) {
                err("RTC addIceCandidate fail (queued)", { login, error: String(e) });
            }
        }
        pendingIce.delete(login);
    }

    async function ensureLocalStream() {
        if (localStream) {
            dbg("MEDIA reuse localStream");
            return localStream;
        }

        dbg("MEDIA getUserMedia request", { audio: true, video: false });

        try {
            if (navigator.mediaDevices?.enumerateDevices) {
                try {
                    const devices = await navigator.mediaDevices.enumerateDevices();
                    const counts = devices.reduce(
                        (acc, device) => {
                            acc[device.kind] = (acc[device.kind] || 0) + 1;
                            return acc;
                        },
                        { audioinput: 0, audiooutput: 0, videoinput: 0 }
                    );
                    dbg("MEDIA enumerateDevices counts", counts);
                    if (counts.audioinput === 0) {
                        addLine("⚠️ В системе нет устройства ввода (audioinput=0)");
                        return null;
                    }
                } catch (e) {
                    err("MEDIA enumerateDevices fail", e);
                }
            }

            localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            addLine("🎙️ Микрофон получен");
            dbg("MEDIA getUserMedia ok", {
                tracks: localStream.getTracks().map((t) => ({ kind: t.kind, enabled: t.enabled, muted: t.muted })),
            });
            return localStream;
        } catch (e) {
            err("MEDIA getUserMedia fail", e);
            const name = e && e.name ? e.name : "";
            let message = "Микрофон не найден / не доступен. Проверь устройство, разрешения сайта и настройки Windows/Chrome.";

            if (name === "NotAllowedError" || name === "PermissionDeniedError") {
                message = "Нет разрешения на микрофон";
            } else if (name === "NotFoundError") {
                message = "Микрофон не найден";
            } else if (name === "NotReadableError" || name === "AbortError") {
                message = "Устройство занято/недоступно";
            } else if (name === "SecurityError") {
                message = "Нужен HTTPS/безопасный контекст";
            }

            addLine("⚠️ " + message);

            if (!micHelpShown) {
                micHelpShown = true;
                addLine("ℹ️ Если микрофон недоступен, попробуйте:");
                addLine("1) Нажмите значок замка в адресной строке → Разрешить микрофон");
                addLine("2) Откройте chrome://settings/content/microphone и выберите устройство");
                addLine("3) Windows: Настройки → Конфиденциальность → Микрофон → разрешить доступ");
            }

            return null;
        }
    }

    function createRemoteAudio(login) {
        dbg("AUDIO createRemoteAudio()", login);

        let container = remoteAudios || document.getElementById("remoteAudios");
        if (!container && appView) {
            container = document.createElement("div");
            container.id = "remoteAudios";
            container.hidden = true;
            appView.appendChild(container);
            dbg("AUDIO remoteAudios container created", login);
        }
        if (!container) {
            err("AUDIO createRemoteAudio(): container missing", login);
            return null;
        }
        container.hidden = false;

        let el = document.getElementById("remoteAudio_" + login);
        if (!el) {
            el = document.createElement("audio");
            el.id = "remoteAudio_" + login;
            el.autoplay = true;
            el.controls = true;
            el.style.width = "100%";
            el.style.marginTop = "8px";

            const label = document.createElement("div");
            label.className = "muted small";
            label.textContent = "🔊 " + login;

            const wrap = document.createElement("div");
            wrap.appendChild(label);
            wrap.appendChild(el);
            container.appendChild(wrap);

            dbg("AUDIO remote element created", el.id);
        }
        return el;
    }

    async function createPeer(login) {
        dbg("RTC createPeer()", login);

        if (peers.has(login)) {
            dbg("RTC createPeer() reuse", login);
            return peers.get(login);
        }

        const stream = await ensureLocalStream();
        if (!stream) {
            err("RTC createPeer() blocked: no localStream", login);
            return null;
        }

        dbg("RTC creating RTCPeerConnection", login);
        const pc = new RTCPeerConnection({
						 
            iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
			  
        });

        for (const track of stream.getTracks()) {
            pc.addTrack(track, stream);
        }

        pc.onicecandidate = (ev) => {
            if (ev.candidate) {
                dbg("RTC icecandidate ->", { to: login, candidate: ev.candidate });
                wsSend({ type: "webrtc", payload: { t: "ice", from: me, to: login, c: ev.candidate } });
            } else {
                dbg("RTC icecandidate: null (end of candidates)", login);
            }
        };

        pc.onconnectionstatechange = () => {
            addLine(`📡 ${login} RTC: ${pc.connectionState}`);
            dbg("RTC connectionStateChange", { login, state: pc.connectionState });
            renderUsers(lastUsers);
        };

        pc.onsignalingstatechange = () => {
            dbg("RTC signalingStateChange", { login, state: pc.signalingState });
        };

        pc.oniceconnectionstatechange = () => {
            dbg("RTC iceConnectionStateChange", { login, state: pc.iceConnectionState });
        };

        pc.ontrack = (ev) => {
            dbg("RTC ontrack", { login, streams: ev.streams?.length, track: { kind: ev.track?.kind } });
            const audio = createRemoteAudio(login);
            if (!audio) return;
            audio.srcObject = ev.streams[0];
            addLine("🔊 Удалённый звук: " + login);
        };

        const ref = { pc };
        peers.set(login, ref);

        dbg("RTC peer created", { login, peers: peers.size });
        return ref;
    }

    async function startCallTo(login) {
        dbg("CALL startCallTo()", login);

        if (!wsReady) {
            addLine("⚠️ WS не подключен — звонок невозможен");
            err("CALL blocked: wsReady=false");
            return;
        }

        let ref;
        try {
            ref = await createPeer(login);
        } catch (e) {
            err("CALL startCallTo() createPeer fail", e);
            addLine("⚠️ Не удалось начать звонок: микрофон недоступен");
            renderUsers(lastUsers);
            return;
        }

        if (!ref) {
            addLine("⚠️ Звонок отменён: микрофон недоступен");
            renderUsers(lastUsers);
            return;
        }

        const { pc } = ref;

        dbg("CALL createOffer()", login);
        let offer;
        try {
            offer = await pc.createOffer();
        } catch (e) {
            err("CALL createOffer() fail", e);
            addLine("⚠️ Не удалось создать offer — звонок отменён");
            renderUsers(lastUsers);
            return;
        }

        dbg("CALL setLocalDescription(offer)", { login, sdpType: offer.type });
        try {
            await pc.setLocalDescription(offer);
        } catch (e) {
            err("CALL setLocalDescription(offer) fail", e);
            addLine("⚠️ Не удалось установить локальное описание — звонок отменён");
            renderUsers(lastUsers);
            return;
        }

        wsSend({ type: "webrtc", payload: { t: "offer", from: me, to: login, sdp: offer } });
        addLine("📤 offer -> " + login);

        renderUsers(lastUsers);
    }

    async function onOffer(from, sdp) {
        dbg("CALL onOffer()", { from, hasSdp: !!sdp });

        if (pendingIncomingCall) {
            if (pendingIncomingCall.from === from) {
                dbg("CALL onOffer(): duplicate offer ignored", { from });
                return;
            }
            addLine("⛔ Входящий звонок от " + from + " отклонён: занято");
            wsSend({ type: "webrtc", payload: { t: "reject", from: me, to: from } });
            return;
        }

        if (peers.has(from)) {
            addLine("⛔ Входящий звонок от " + from + " отклонён: уже есть соединение");
            wsSend({ type: "webrtc", payload: { t: "reject", from: me, to: from } });
            return;
        }

        pendingIncomingCall = { from, sdp, ts: Date.now() };
        addLine("📥 Входящий звонок от " + from);
        showIncomingModal(from);
    }

    async function acceptIncomingCall() {
        if (!pendingIncomingCall) return;

        const { from, sdp } = pendingIncomingCall;
        pendingIncomingCall = null;
        hideIncomingModal();

        addLine("✅ Принят звонок от " + from);

        const ref = await createPeer(from);
        if (!ref) {
            addLine("⚠️ Не удалось принять звонок от " + from + ": микрофон недоступен");
            wsSend({ type: "webrtc", payload: { t: "reject", from: me, to: from } });
            return;
        }
        const { pc } = ref;

        dbg("CALL setRemoteDescription(offer)", from);
        await pc.setRemoteDescription(sdp);
        await flushPendingIce(from, pc);

        dbg("CALL createAnswer()", from);
        const answer = await pc.createAnswer();

        dbg("CALL setLocalDescription(answer)", { from, sdpType: answer.type });
        await pc.setLocalDescription(answer);

        wsSend({ type: "webrtc", payload: { t: "answer", from: me, to: from, sdp: answer } });
        addLine("📤 answer -> " + from);

        renderUsers(lastUsers);
    }

    function rejectIncomingCall() {
        if (!pendingIncomingCall) return;

        const { from } = pendingIncomingCall;
        pendingIncomingCall = null;
        pendingIce.delete(from);
        hideIncomingModal();

        addLine("⛔ Входящий звонок отклонён: " + from);
        wsSend({ type: "webrtc", payload: { t: "reject", from: me, to: from } });
    }

    async function onAnswer(from, sdp) {
        dbg("CALL onAnswer()", { from, hasSdp: !!sdp });

        addLine("📥 answer <- " + from);
        const ref = peers.get(from);
        if (!ref) {
            err("CALL onAnswer(): peer not found", from);
            return;
        }

        const pc = ref.pc;
        dbg("CALL onAnswer(): signalingState", { from, state: pc.signalingState });

        if (pc.signalingState !== "have-local-offer") {
            addLine(`⚠️ answer игнор (state=${pc.signalingState}) от ${from}`);
            err("CALL onAnswer(): ignored by state", { from, state: pc.signalingState });
            return;
        }

        dbg("CALL setRemoteDescription(answer)", from);
        await pc.setRemoteDescription(sdp);
        await flushPendingIce(from, pc);

        renderUsers(lastUsers);
    }


    async function onIce(from, candidate) {
        dbg("RTC onIce()", { from, hasCandidate: !!candidate });

        const ref = peers.get(from);
        if (!ref) {
            if (pendingIncomingCall && pendingIncomingCall.from === from) {
                const queued = pendingIce.get(from) || [];
                queued.push(candidate);
                pendingIce.set(from, queued);
                dbg("RTC onIce(): queued (pending accept)", { from, queued: queued.length });
                return;
            }
            err("RTC onIce(): peer not found", from);
            return;
        }

        if (!ref.pc.remoteDescription) {
            const queued = pendingIce.get(from) || [];
            queued.push(candidate);
            pendingIce.set(from, queued);
            dbg("RTC onIce(): queued (no remoteDescription)", { from, queued: queued.length });
            return;
        }

        try {
            await ref.pc.addIceCandidate(candidate);
            dbg("RTC addIceCandidate ok", from);
        } catch (e) {
            err("RTC addIceCandidate fail (ignored)", { from, error: String(e) });
            // ignore
        }
    }

    function cleanupPeer(login) {
        dbg("RTC cleanupPeer()", login);
        pendingIce.delete(login);

        const ref = peers.get(login);
        if (!ref) {
            dbg("RTC cleanupPeer(): no peer", login);
            return;
        }

        try {
            ref.pc.close();
            dbg("RTC pc.close() ok", login);
        } catch (e) {
            err("RTC pc.close() error", { login, error: String(e) });
        }

        peers.delete(login);
        dbg("RTC peer removed", { login, peers: peers.size });

        // удалить аудио элемент
        const el = document.getElementById("remoteAudio_" + login);
        if (el && el.parentElement && el.parentElement.parentElement) {
            el.parentElement.parentElement.remove();
            dbg("AUDIO remote element removed", "remoteAudio_" + login);
        }
    }

    function hangup(login) {
        dbg("CALL hangup()", login);

        if (!wsReady) {
            dbg("CALL hangup(): wsReady=false, local cleanup only", login);
            return cleanupPeer(login);
        }

        wsSend({ type: "webrtc", payload: { t: "hangup", from: me, to: login } });
        cleanupPeer(login);

        addLine("⛔ звонок завершён: " + login);
        renderUsers(lastUsers);
    }

    function hangupAll() {
        dbg("CALL hangupAll()", { peers: peers.size });

        for (const login of Array.from(peers.keys())) {
            hangup(login);
        }
        btnHangupAll.disabled = true;
    }

    // ---- Users rendering ----
    function isOnline(login) {
        const u = lastUsers.find((x) => x.login === login);
        return u && u.status === "online";
    }

    function isConnectedTo(login) {
        const ref = peers.get(login);
        if (!ref) return false;
        const st = ref.pc.connectionState;
        return st === "connecting" || st === "connected";
    }

    function renderUsers(users) {
        lastUsers = users || [];
        dbg("UI renderUsers()", {
            total: lastUsers.length,
            selectedForConf: Array.from(selectedForConf),
            peers: Array.from(peers.keys()),
        });

        usersBody.innerHTML = "";

        // вычищаем выбранных, если пользователь оффлайн
        for (const x of Array.from(selectedForConf)) {
            if (!isOnline(x)) {
                dbg("CONF selected removed (offline)", x);
                selectedForConf.delete(x);
            }
        }

        const meLogin = me;

        const others = lastUsers.filter((u) => u.login !== meLogin);

        for (const u of others) {
            const tr = document.createElement("tr");

            // conf checkbox
            const tdSel = document.createElement("td");
            tdSel.className = "col-select";
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.className = "checkbox";
            cb.disabled = (u.status !== "online");
            cb.checked = selectedForConf.has(u.login);
            cb.onchange = () => {
                dbg("CONF checkbox change", { login: u.login, checked: cb.checked });

                if (cb.checked) selectedForConf.add(u.login);
                else selectedForConf.delete(u.login);

                updateConfUI();
            };
            tdSel.appendChild(cb);

            const tdUser = document.createElement("td");
            tdUser.className = "user-cell";
            const userName = document.createElement("span");
            userName.className = "user-name";
            userName.textContent = u.login;

            const tdStatus = document.createElement("td");
            tdStatus.className = "status-cell";
            const tag = document.createElement("span");
            tag.className = "tag " + (u.status === "online" ? "on" : "off");
            tag.textContent = (u.status === "online" ? "в сети" : "не в сети");
            tdStatus.appendChild(tag);
            const tagMobile = document.createElement("span");
            tagMobile.className = tag.className + " status-chip-mobile";
            tagMobile.textContent = tag.textContent;
            tdUser.appendChild(userName);
            tdUser.appendChild(tagMobile);

            // call
            const tdCall = document.createElement("td");
            const callBtn = document.createElement("button");
            const connected = isConnectedTo(u.login);
            callBtn.textContent = connected ? "Отключить" : "Позвонить";
            callBtn.disabled = (u.status !== "online") && !connected;

            callBtn.className = connected ? "btn-danger btn-full" : "btn-primary btn-full";
            callBtn.onclick = async () => {
                dbg("UI call button click", { login: u.login, connected, status: u.status });

                if (connected) {
                    hangup(u.login);
                    return;
                }
                await startCallTo(u.login);
            };
            tdCall.appendChild(callBtn);

            // add to conf quick action
            const tdConf = document.createElement("td");
            const addBtn = document.createElement("button");
            addBtn.textContent = selectedForConf.has(u.login) ? "Убрать" : "Добавить";
            addBtn.disabled = (u.status !== "online");
            addBtn.className = "btn-full";
            addBtn.onclick = () => {
                dbg("UI conf add/remove click", { login: u.login });

                if (selectedForConf.has(u.login)) selectedForConf.delete(u.login);
                else selectedForConf.add(u.login);

                updateConfUI();
                renderUsers(lastUsers);
            };
            tdConf.appendChild(addBtn);

            tr.appendChild(tdSel);
            tr.appendChild(tdUser);
            tr.appendChild(tdStatus);
            tr.appendChild(tdCall);
            tr.appendChild(tdConf);

            usersBody.appendChild(tr);
        }

        btnHangupAll.disabled = peers.size === 0;
        updateConfUI();
    }

    function updateConfUI() {
        const sel = Array.from(selectedForConf);

        confInfo.textContent = sel.length === 0
            ? "Выбери 2+ пользователей “в сети” для конференции."
            : "Выбраны: " + sel.join(", ");

        // Конференция доступна, если выбрано 2+ и WS есть
        btnConf.disabled = !(wsReady && sel.length >= 2);

        dbg("CONF updateConfUI()", { wsReady, selected: sel, btnConfDisabled: btnConf.disabled });
    }

    async function refreshUsers() {
        dbg("USERS refreshUsers()");

        try {
            const data = await apiFetch("/users.php");
            dbg("USERS data", data);

            if (!data.ok) {
                dbg("USERS not authorized -> force logout UI", { error: data.error });

                // разлогин
                stopTimers();
                appView.hidden = true;
                loginView.hidden = false;
                me = null;
                setWsState("offline", false);
                return;
            }

            onlineInfo.textContent = "онлайн: " + data.onlineCount;
            renderUsers(data.users);
        } catch (e) {
            err("USERS refreshUsers error", { message: e.message, status: e.status, data: e.data });

            if (e.status === 401) {
                dbg("USERS 401 -> force logout UI");

                // разлогин
                stopTimers();
                appView.hidden = true;
                loginView.hidden = false;
                me = null;
                setWsState("offline", false);
                return;
            }
        }
    }

    // ---- Conference action ----
    btnConf.onclick = async () => {
        const targets = Array.from(selectedForConf).filter((u) => isOnline(u));

        dbg("CONF btnConf click", { selected: Array.from(selectedForConf), targets });

        if (targets.length < 2) return;

        addLine("🎛️ Конференция: " + targets.join(", "));

        // Запускаем соединение с каждым выбранным
        for (const t of targets) {
            if (!isConnectedTo(t)) {
                dbg("CONF connect to", t);
                // eslint-disable-next-line no-await-in-loop
                await startCallTo(t);
            } else {
                dbg("CONF already connected", t);
            }
        }

        renderUsers(lastUsers);
    };

    btnHangupAll.onclick = () => {
        dbg("UI btnHangupAll click");
        hangupAll();
    };

    if (acceptBtn) {
        acceptBtn.onclick = () => {
            dbg("UI acceptBtn click");
            acceptIncomingCall();
        };
    }

    if (rejectBtn) {
        rejectBtn.onclick = () => {
            dbg("UI rejectBtn click");
            rejectIncomingCall();
        };
    }

    // ---- Login / Logout ----
    async function doLogin() {
        dbg("AUTH doLogin()");

        setLoginError("");
        const login = (loginInput.value || "").trim();
        const password = (passInput.value || "").trim();

        dbg("AUTH login attempt", { login, passLen: password.length });

        if (!login || !password) {
            setLoginError("Введите логин и пароль.");
            return;
        }

        btnLogin.disabled = true;

        try {
            const data = await apiFetch("/login.php", {
                method: "POST",
                body: JSON.stringify({ login, password }),
            });

            dbg("AUTH login ok", data);

            me = data.login;
            meEl.textContent = "Вы: " + me;

            loginView.hidden = true;
            appView.hidden = false;

            addLine("👋 Вход: " + me);

            await startTimers();
            connectWs();
        } catch (e) {
            err("AUTH login fail", { message: e.message, status: e.status, data: e.data });

            setLoginError(
                e.message === "bad_credentials"
                    ? "Неверный логин/пароль."
                    : ("Ошибка входа: " + e.message)
            );
        } finally {
            btnLogin.disabled = false;
        }
    }

    async function doLogout() {
        dbg("AUTH doLogout()");

        try {
            await apiFetch("/logout.php", { method: "POST", body: "{}" });
            dbg("AUTH logout api ok");
        } catch (e) {
            err("AUTH logout api fail (ignored)", { message: e.message, status: e.status });
        }

        stopTimers();

        if (ws) {
            try {
                dbg("WS close on logout");
                ws.close();
            } catch (e) {
                err("WS close error on logout", String(e));
            }
        }

        ws = null;
        wsReady = false;

        for (const u of Array.from(peers.keys())) cleanupPeer(u);
        selectedForConf.clear();
        pendingIncomingCall = null;
        pendingIce.clear();
        hideIncomingModal();

        appView.hidden = true;
        loginView.hidden = false;

        me = null;
        loginInput.value = "";
        passInput.value = "";

        setWsState("offline", false);
        usersBody.innerHTML = "";

        addLine("👋 Вы вышли");
    }

    btnLogin.onclick = () => {
        dbg("UI btnLogin click");
        doLogin();
    };

    btnLogout.onclick = () => {
        dbg("UI btnLogout click");
        doLogout();
    };

    if (logToggle) {
        logToggle.onclick = () => {
            dbg("UI logToggle click");
            const isCollapsed = appView.classList.toggle("log-collapsed");
            updateLogToggleLabel(isCollapsed);
        };
        updateLogToggleLabel(false);
    }

    passInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            dbg("UI passInput Enter");
            doLogin();
        }
    });

    loginInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            dbg("UI loginInput Enter");
            doLogin();
        }
    });

    // при закрытии вкладки постараемся разлогиниться (не гарантировано)
    window.addEventListener("beforeunload", () => {
        dbg("WINDOW beforeunload -> sendBeacon logout");

        try {
            navigator.sendBeacon(
                API + "/logout.php",
                new Blob(["{}"], { type: "application/json" })
            );
        } catch (e) {
            err("WINDOW sendBeacon fail (ignored)", String(e));
        }
    });

    // ---- Boot ----
    async function boot() {
        dbg("BOOT boot()");
        setWsState("offline", false);

        // Попытка авто-входа по существующей PHP-сессии
        try {
            dbg("BOOT try auto-session (/users.php)");
            const data = await apiFetch("/users.php");

            if (!data.ok) {
                dbg("BOOT auto-session not authorized -> show login", { error: data.error });

                loginView.hidden = false;
                appView.hidden = true;
                return;
            }

            dbg("BOOT auto-session ok", data);

            me = data.me;
            meEl.textContent = "Вы: " + me;

            loginView.hidden = true;
            appView.hidden = false;

            await startTimers();
            connectWs();
        } catch (e) {
            dbg("BOOT auto-session fail -> show login", { message: e.message, status: e.status });

            loginView.hidden = false;
            appView.hidden = true;
        }
    }

    boot();
})();
