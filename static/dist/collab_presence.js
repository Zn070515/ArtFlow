"use strict";
(() => {
    "use strict";
    const root = document.querySelector("[data-collab-presence]");
    if (!root)
        return;
    const socketPath = root.dataset.collabWsUrl;
    const resource = root.dataset.collabResource;
    const membersList = root.querySelector("[data-collab-members]");
    const status = root.querySelector("[data-collab-status]");
    if (!socketPath || !resource || !membersList || !status)
        return;
    const resolvedSocketPath = socketPath;
    const resolvedMembersList = membersList;
    const resolvedStatus = status;
    const clientStorageKey = "artflow:collab:client-id";
    const existingClientId = window.sessionStorage.getItem(clientStorageKey);
    const clientId = existingClientId || crypto.randomUUID().replace(/-/g, "");
    if (!existingClientId)
        window.sessionStorage.setItem(clientStorageKey, clientId);
    const HEARTBEAT_MS = 15000;
    const MAX_RECONNECT_DELAY_MS = 10000;
    let socket = null;
    let heartbeatTimer;
    let reconnectTimer;
    let reconnectDelay = 1000;
    let stopped = false;
    const members = new Map();
    function socketUrl() {
        const url = new URL(resolvedSocketPath, window.location.origin);
        url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set("client_id", clientId);
        return url.toString();
    }
    function renderMembers() {
        resolvedMembersList.replaceChildren();
        if (members.size === 0) {
            const empty = document.createElement("li");
            empty.className = "text-gray-500";
            empty.textContent = "当前没有其他工作人员在线";
            resolvedMembersList.append(empty);
            return;
        }
        for (const member of members.values()) {
            const item = document.createElement("li");
            item.className = "flex items-center justify-between gap-3";
            const name = document.createElement("span");
            name.textContent = member.display;
            item.append(name);
            if (member.path) {
                const path = document.createElement("span");
                path.className = "truncate text-xs text-gray-500";
                path.textContent = member.path;
                item.append(path);
            }
            resolvedMembersList.append(item);
        }
    }
    function addMember(value) {
        if (!value || typeof value !== "object")
            return;
        const member = value;
        if (typeof member.client_id !== "string" || typeof member.display !== "string")
            return;
        members.set(member.client_id, {
            client_id: member.client_id,
            display: member.display,
            path: typeof member.path === "string" ? member.path : "",
        });
    }
    function removeMember(value) {
        if (typeof value === "string")
            members.delete(value);
    }
    function setStatus(value, className) {
        resolvedStatus.textContent = value;
        resolvedStatus.className = className;
    }
    function clearTimers() {
        if (heartbeatTimer !== undefined)
            window.clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
        if (reconnectTimer !== undefined)
            window.clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
    }
    function send(value) {
        if (socket?.readyState === WebSocket.OPEN)
            socket.send(JSON.stringify(value));
    }
    function scheduleReconnect() {
        if (stopped || reconnectTimer !== undefined)
            return;
        setStatus("协作提示暂不可用，页面仍可正常使用。", "text-xs text-amber-700");
        reconnectTimer = window.setTimeout(() => {
            reconnectTimer = undefined;
            connect();
        }, reconnectDelay);
        reconnectDelay = Math.min(MAX_RECONNECT_DELAY_MS, reconnectDelay * 2);
    }
    function connect() {
        if (stopped)
            return;
        clearTimers();
        setStatus("正在连接协作提示…", "text-xs text-gray-500");
        socket = new WebSocket(socketUrl());
        socket.addEventListener("open", () => {
            reconnectDelay = 1000;
            setStatus("协作提示已连接", "text-xs text-green-700");
            heartbeatTimer = window.setInterval(() => send({ type: "heartbeat" }), HEARTBEAT_MS);
            send({ type: "heartbeat" });
        });
        socket.addEventListener("message", (event) => {
            let value;
            try {
                value = JSON.parse(event.data);
            }
            catch {
                return;
            }
            if (!value || typeof value !== "object")
                return;
            const message = value;
            if (message.type === "presence.snapshot" && Array.isArray(message.members)) {
                members.clear();
                for (const member of message.members)
                    addMember(member);
                renderMembers();
            }
            else if (message.type === "presence.join" || message.type === "presence.focus") {
                addMember(message.member);
                renderMembers();
            }
            else if (message.type === "presence.leave") {
                removeMember(message.client_id);
                renderMembers();
            }
            else if (message.type === "presence.blur") {
                addMember(message.member);
                renderMembers();
            }
        });
        socket.addEventListener("close", () => {
            clearTimers();
            scheduleReconnect();
        });
        socket.addEventListener("error", () => {
            socket?.close();
        });
    }
    root.addEventListener("focusin", (event) => {
        const target = event.target;
        if (target instanceof HTMLElement) {
            const path = target.dataset.collabPath;
            if (path)
                send({ type: "presence.focus", path });
        }
    });
    root.addEventListener("focusout", (event) => {
        if (event.target instanceof HTMLElement && event.target.dataset.collabPath) {
            send({ type: "presence.blur" });
        }
    });
    window.addEventListener("beforeunload", () => {
        stopped = true;
        clearTimers();
        socket?.close();
    });
    renderMembers();
    connect();
})();
