// TelePort MVP client
(() => {
    const $ = (id) => document.getElementById(id);

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

    const btnConf = $("btnConf");
    const btnHangupAll = $("btnHangupAll");
    const btnLogout = $("btnLogout");

    const API = "../api";

    // ---- UI helpers ----
    function addLine(text) {
        const div = document.createElement("div");
        div.textContent = text;
        logEl.appendChild(div);
        logEl.scrollTop = logEl.scrollHeight;
    }

    function setWsState(state, ok) {
        wsStateEl.textContent = "WS: " + state;
        wsDot.className = "dot " + (ok ? "on" : "off");
    }

    function setLoginError(msg) {
        loginError.textContent = msg || "";
    }

    async function apiFetch(path, options = {}) {
        const res = await fetch(API + path + (path.includes("?") ? "&" : "?") + "ts=" + Date.now(), {
            credentials: "include",
            ...options,
            headers: {
                "Content-Type": "application/json",
                ...(options.headers || {}),
            },
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const err = data && data.error ? data.error : "http_" + res.status;
            const e = new Error(err);
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
        stopTimers();
        // ping: держим сессию живой
        pingTimer = setInterval(async () => {
            try { await apiFetch("/ping.php", { method: "POST", body: "{}" }); }
            catch { /* ignore */ }
        }, 10_000);

        // users refresh
        usersTimer = setInterval(refreshUsers, 3_000);
        await refreshUsers();
    }

    function stopTimers() {
        if (pingTimer) clearInterval(pingTimer);
        if (usersTimer) clearInterval(usersTimer);
        pingTimer = null;
        usersTimer = null;
    }

    // ---- WebSocket signaling + WebRTC ----
    let ws = null;
    let wsReady = false;

    // peer connections per user
    const peers = new Map(); // login -> { pc, audioEl }
    let localStream = null;

    function wsUrl() {
        const proto = location.protocol === "https:" ? "wss" : "ws";
        // предполагаем, что nginx/Caddy проксируют /ws -> node:3000
        return `${proto}://${location.host}/ws`;
    }

    function connectWs() {
        if (ws) {
            try { ws.close(); } catch { }
            ws = null;
        }

        wsReady = false;
        setWsState("подключаемся…", false);

        ws = new WebSocket(wsUrl());

        ws.onopen = () => {
            wsReady = true;
            setWsState("online", true);
            addLine("✅ WS подключен");
            // join
            wsSend({ type: "join", name: me });
        };

        ws.onclose = () => {
            wsReady = false;
            setWsState("offline", false);
            addLine("⛔ WS отключен");
        };

        ws.onerror = () => {
            wsReady = false;
            setWsState("ошибка", false);
        };

        ws.onmessage = async (e) => {
            let data = null;
            try { data = JSON.parse(e.data); } catch { return; }

            if (data.type === "sys") {
                addLine("🔧 " + (data.text || ""));
                return;
            }

            if (data.type === "webrtc") {
                const p = data.payload || {};
                const from = p.from;
                if (!from) return;

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
                    addLine("⛔ " + from + " завершил звонок");
                    cleanupPeer(from);
                    renderUsers(lastUsers);
                    return;
                }
            }
        };
    }

    function wsSend(obj) {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify(obj));
    }

    async function ensureLocalStream() {
        if (localStream) return localStream;
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        addLine("🎙️ Микрофон получен");
        return localStream;
    }

    function createRemoteAudio(login) {
        const container = document.getElementById("remoteAudios");
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
        }
        return el;
    }

    async function createPeer(login) {
        if (peers.has(login)) return peers.get(login);

        const stream = await ensureLocalStream();
        const pc = new RTCPeerConnection({
            iceServers: [
                { urls: "stun:stun.l.google.com:19302" },
            ],
        });

        for (const track of stream.getTracks()) pc.addTrack(track, stream);

        pc.onicecandidate = (ev) => {
            if (ev.candidate) {
                wsSend({ type: "webrtc", payload: { t: "ice", from: me, to: login, c: ev.candidate } });
            }
        };

        pc.onconnectionstatechange = () => {
            addLine(`📡 ${login} RTC: ${pc.connectionState}`);
            renderUsers(lastUsers);
        };

        pc.ontrack = (ev) => {
            const audio = createRemoteAudio(login);
            audio.srcObject = ev.streams[0];
            addLine("🔊 Удалённый звук: " + login);
        };

        const ref = { pc };
        peers.set(login, ref);
        return ref;
    }

    async function startCallTo(login) {
        if (!wsReady) {
            addLine("⚠️ WS не подключен — звонок невозможен");
            return;
        }
        const { pc } = await createPeer(login);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        wsSend({ type: "webrtc", payload: { t: "offer", from: me, to: login, sdp: offer } });
        addLine("📤 offer -> " + login);
        renderUsers(lastUsers);
    }

    async function onOffer(from, sdp) {
        addLine("📥 offer <- " + from);
        const { pc } = await createPeer(from);
        await pc.setRemoteDescription(sdp);

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        wsSend({ type: "webrtc", payload: { t: "answer", from: me, to: from, sdp: answer } });
        addLine("📤 answer -> " + from);
        renderUsers(lastUsers);
    }

    async function onAnswer(from, sdp) {
        addLine("📥 answer <- " + from);
        const ref = peers.get(from);
        if (!ref) return;

        const pc = ref.pc;
        if (pc.signalingState !== "have-local-offer") {
            addLine(`⚠️ answer игнор (state=${pc.signalingState}) от ${from}`);
            return;
        }
        await pc.setRemoteDescription(sdp);
        renderUsers(lastUsers);
    }


    async function onIce(from, candidate) {
        const ref = peers.get(from);
        if (!ref) return;
        try {
            await ref.pc.addIceCandidate(candidate);
        } catch {
            // ignore
        }
    }

    function cleanupPeer(login) {
        const ref = peers.get(login);
        if (!ref) return;
        try { ref.pc.close(); } catch { }
        peers.delete(login);

        // удалить аудио элемент
        const el = document.getElementById("remoteAudio_" + login);
        if (el && el.parentElement && el.parentElement.parentElement) {
            el.parentElement.parentElement.remove();
        }
    }

    function hangup(login) {
        if (!wsReady) return cleanupPeer(login);
        wsSend({ type: "webrtc", payload: { t: "hangup", from: me, to: login } });
        cleanupPeer(login);
        addLine("⛔ звонок завершён: " + login);
        renderUsers(lastUsers);
    }

    function hangupAll() {
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
        usersBody.innerHTML = "";

        // вычищаем выбранных, если пользователь оффлайн
        for (const x of Array.from(selectedForConf)) {
            if (!isOnline(x)) selectedForConf.delete(x);
        }

        const meLogin = me;

        const others = users.filter((u) => u.login !== meLogin);

        for (const u of others) {
            const tr = document.createElement("tr");

            // conf checkbox
            const tdSel = document.createElement("td");
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.className = "checkbox";
            cb.disabled = (u.status !== "online");
            cb.checked = selectedForConf.has(u.login);
            cb.onchange = () => {
                if (cb.checked) selectedForConf.add(u.login);
                else selectedForConf.delete(u.login);
                updateConfUI();
            };
            tdSel.appendChild(cb);

            const tdUser = document.createElement("td");
            tdUser.textContent = u.login;

            const tdStatus = document.createElement("td");
            const tag = document.createElement("span");
            tag.className = "tag " + (u.status === "online" ? "on" : "off");
            tag.textContent = (u.status === "online" ? "в сети" : "не в сети");
            tdStatus.appendChild(tag);

            // call
            const tdCall = document.createElement("td");
            const callBtn = document.createElement("button");
            const connected = isConnectedTo(u.login);
            callBtn.textContent = connected ? "Отключить" : "Позвонить";
            callBtn.disabled = (u.status !== "online") && !connected;

            callBtn.className = connected ? "btn-danger" : "btn-primary";
            callBtn.onclick = async () => {
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
            addBtn.onclick = () => {
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
    }

    async function refreshUsers() {
        try {
            const data = await apiFetch("/users.php");
            onlineInfo.textContent = "онлайн: " + data.onlineCount;
            renderUsers(data.users);
        } catch (e) {
            if (e.status === 401) {
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
        if (targets.length < 2) return;

        addLine("🎛️ Конференция: " + targets.join(", "));
        // Запускаем соединение с каждым выбранным
        for (const t of targets) {
            if (!isConnectedTo(t)) {
                // eslint-disable-next-line no-await-in-loop
                await startCallTo(t);
            }
        }
        renderUsers(lastUsers);
    };

    btnHangupAll.onclick = hangupAll;

    // ---- Login / Logout ----
    async function doLogin() {
        setLoginError("");
        const login = (loginInput.value || "").trim();
        const password = (passInput.value || "").trim();
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

            me = data.login;
            meEl.textContent = "Вы: " + me;

            loginView.hidden = true;
            appView.hidden = false;

            addLine("👋 Вход: " + me);

            await startTimers();
            connectWs();
        } catch (e) {
            setLoginError(e.message === "bad_credentials" ? "Неверный логин/пароль." : ("Ошибка входа: " + e.message));
        } finally {
            btnLogin.disabled = false;
        }
    }

    async function doLogout() {
        try { await apiFetch("/logout.php", { method: "POST", body: "{}" }); } catch { }
        stopTimers();
        if (ws) { try { ws.close(); } catch { } }
        ws = null;
        wsReady = false;

        for (const u of Array.from(peers.keys())) cleanupPeer(u);
        selectedForConf.clear();

        appView.hidden = true;
        loginView.hidden = false;
        me = null;
        loginInput.value = "";
        passInput.value = "";
        setWsState("offline", false);
        usersBody.innerHTML = "";
        addLine("👋 Вы вышли");
    }

    btnLogin.onclick = doLogin;
    btnLogout.onclick = doLogout;

    passInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") doLogin();
    });
    loginInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") doLogin();
    });

    // при закрытии вкладки постараемся разлогиниться (не гарантировано)
    window.addEventListener("beforeunload", () => {
        try { navigator.sendBeacon(API + "/logout.php", new Blob(["{}"], { type: "application/json" })); } catch { }
    });

    // ---- Boot ----
    async function boot() {
        setWsState("offline", false);

        // Попытка авто-входа по существующей PHP-сессии
        try {
            const data = await apiFetch("/users.php");
            me = data.me;
            meEl.textContent = "Вы: " + me;

            loginView.hidden = true;
            appView.hidden = false;

            await startTimers();
            connectWs();
        } catch {
            loginView.hidden = false;
            appView.hidden = true;
        }
    }

    boot();
})();