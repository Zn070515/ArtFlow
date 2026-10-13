"use strict";
(() => {
    "use strict";
    let idCounter = 0;
    function stableId(prefix) {
        const cryptoObject = window.crypto;
        if (typeof cryptoObject?.randomUUID === "function") {
            return `${prefix}-${cryptoObject.randomUUID()}`;
        }
        idCounter += 1;
        return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
    }
    function planningField(value, unit, resolution = "confirmed") {
        return { value, resolution, evidence: "工作人员填写", unit };
    }
    function clonePayload(payload) {
        return JSON.parse(JSON.stringify(payload));
    }
    function buildPlanningPayload(payload) {
        const next = clonePayload(payload);
        next.schema_version = 1;
        next.execution_refs = next.execution_refs ?? {};
        next.stages = next.stages.map((stage) => {
            stage.judge_sources = Array.isArray(stage.judge_sources) ? stage.judge_sources : [];
            stage.judge_sources.forEach((round) => {
                if (typeof round.weight?.value === "number")
                    round.weight.value = String(round.weight.value);
            });
            if (typeof stage.audience_weight?.value === "number") {
                stage.audience_weight.value = String(stage.audience_weight.value);
            }
            return stage;
        });
        return next;
    }
    function addStage(payload, options = {}) {
        payload.execution_refs = payload.execution_refs ?? {};
        const stage = {
            business_id: stableId("stage"),
            name: planningField(options.name ?? "新比赛阶段", "text"),
            advance_count: planningField(null, "person", "pending"),
            result_method: planningField("top_n", "text"),
            judge_sources: [],
            audience_weight: planningField("0%", "percent"),
            audience_source: planningField("", "vote"),
        };
        payload.stages.push(stage);
        return stage;
    }
    function removeStage(payload, businessId) {
        payload.execution_refs = payload.execution_refs ?? {};
        const before = payload.stages.length;
        payload.stages = payload.stages.filter((stage) => stage.business_id !== businessId);
        delete payload.execution_refs[businessId];
        return payload.stages.length !== before;
    }
    function addRound(stage, options = {}) {
        stage.judge_sources = Array.isArray(stage.judge_sources) ? stage.judge_sources : [];
        const businessId = stableId("round");
        const round = {
            business_id: businessId,
            round_key: businessId,
            name: planningField(options.name ?? "演唱轮次", "text"),
            format: options.format ?? "solo",
            weight: planningField(null, "percent", "pending"),
        };
        stage.judge_sources.push(round);
        return round;
    }
    function formatDecimal(value) {
        return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
    }
    function formatPercentageTotal(values) {
        const total = values.reduce((sum, value) => {
            const numeric = Number.parseFloat(value.trim().replace(/%$/, ""));
            return Number.isFinite(numeric) ? sum + numeric : sum;
        }, 0);
        const totalText = formatDecimal(total);
        return { total: totalText, label: `${values.join(" + ")} = ${totalText}%` };
    }
    const api = {
        buildPlanningPayload,
        formatPercentageTotal,
        addStage,
        removeStage,
        addRound,
    };
    window.ArtFlowRulesetPlanning = api;
    const root = document.querySelector("#ruleset-planning-app");
    if (!root)
        return;
    const payloadElement = document.querySelector("#ruleset-planning-payload");
    if (!payloadElement?.textContent)
        return;
    let payload = JSON.parse(payloadElement.textContent);
    payload = buildPlanningPayload(payload);
    const revisionState = { value: Number.parseInt(root.dataset.revision ?? "0", 10) || 0 };
    const stageList = root.querySelector("#planning-stage-list");
    const stageCount = root.querySelector("#planning-stage-count");
    const feedback = root.querySelector("#planning-feedback");
    const resultElement = document.querySelector("#ruleset-planning-result");
    const result = resultElement?.textContent ? JSON.parse(resultElement.textContent) : {};
    const csrfToken = root.querySelector("[name='csrfmiddlewaretoken']")?.value ?? "";
    function fieldValue(field, fallback = "") {
        if (!field || field.value === null || field.value === undefined)
            return fallback;
        return String(field.value);
    }
    function updateField(field, value, unit) {
        field.value = value;
        field.unit = unit;
        field.resolution = value.trim() ? "confirmed" : "pending";
        field.evidence = "工作人员填写";
    }
    function makeInput(value, label, onInput) {
        const labelElement = document.createElement("label");
        labelElement.className = "block text-sm text-gray-700";
        labelElement.textContent = label;
        const input = document.createElement("input");
        input.className = "mt-1 w-full border border-gray-300 rounded px-3 py-2";
        input.value = value;
        input.addEventListener("input", () => onInput(input.value));
        labelElement.appendChild(input);
        return input;
    }
    function renderStages() {
        if (!stageList)
            return;
        stageList.replaceChildren();
        payload.stages.forEach((stage, index) => {
            const card = document.createElement("article");
            card.className = "border border-gray-200 rounded-lg p-4 space-y-3";
            const heading = document.createElement("div");
            heading.className = "flex items-center justify-between gap-3";
            const title = document.createElement("h3");
            title.className = "font-semibold text-gray-900";
            title.textContent = `第 ${index + 1} 阶段`;
            const remove = document.createElement("button");
            remove.type = "button";
            remove.className = "text-sm text-red-700";
            remove.textContent = "删除阶段";
            remove.addEventListener("click", () => {
                removeStage(payload, stage.business_id);
                renderStages();
            });
            heading.append(title, remove);
            card.appendChild(heading);
            card.appendChild(makeInput(fieldValue(stage.name), "阶段名称", (value) => updateField(stage.name, value, "text")));
            card.appendChild(makeInput(fieldValue(stage.advance_count), "晋级人数", (value) => updateField(stage.advance_count, value, "person")));
            const rounds = document.createElement("div");
            rounds.className = "space-y-2 border-t border-gray-100 pt-3";
            stage.judge_sources.forEach((round) => {
                const row = document.createElement("div");
                row.className = "grid gap-2 sm:grid-cols-2";
                row.appendChild(makeInput(fieldValue(round.name), "演唱轮次", (value) => updateField(round.name, value, "text")));
                row.appendChild(makeInput(fieldValue(round.weight), "成绩比例", (value) => updateField(round.weight, value, "percent")));
                rounds.appendChild(row);
            });
            const addRoundButton = document.createElement("button");
            addRoundButton.type = "button";
            addRoundButton.className = "border border-gray-300 rounded px-3 py-1.5 text-sm";
            addRoundButton.textContent = "添加演唱轮次";
            addRoundButton.addEventListener("click", () => {
                addRound(stage);
                renderStages();
            });
            rounds.appendChild(addRoundButton);
            card.appendChild(rounds);
            stageList.appendChild(card);
        });
        if (stageCount)
            stageCount.textContent = String(payload.stages.length);
    }
    function showFeedback(message, isError = false) {
        if (!feedback)
            return;
        feedback.className = isError
            ? "mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
            : "mb-5 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800";
        feedback.textContent = message;
    }
    async function post(url) {
        const response = await fetch(url, {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json", "X-CSRFToken": csrfToken, Accept: "application/json" },
            body: JSON.stringify({ revision: revisionState.value, payload: buildPlanningPayload(payload) }),
        });
        const body = await response.json();
        if (!response.ok)
            throw new Error(body.error ?? "保存失败，请检查尚待确定事项。");
        return body;
    }
    root.querySelector("#planning-add-stage")?.addEventListener("click", () => {
        addStage(payload);
        renderStages();
    });
    root.querySelector("#planning-save")?.addEventListener("click", async () => {
        try {
            const response = await post(root.dataset.saveUrl ?? "");
            if (response.revision !== undefined)
                revisionState.value = response.revision;
            showFeedback("准备草稿已保存。");
        }
        catch (error) {
            showFeedback(error instanceof Error ? error.message : "保存失败。", true);
        }
    });
    root.querySelector("#planning-preview")?.addEventListener("click", async () => {
        try {
            const response = await post(root.dataset.previewUrl ?? "");
            showFeedback(response.ok ? "候选方案已准备，可以继续检查。" : "候选方案仍有待确认事项。");
        }
        catch (error) {
            showFeedback(error instanceof Error ? error.message : "预览失败。", true);
        }
    });
    root.querySelector("#planning-apply")?.addEventListener("click", async () => {
        try {
            const saved = await post(root.dataset.saveUrl ?? "");
            if (saved.revision !== undefined)
                revisionState.value = saved.revision;
            const response = await post(root.dataset.applyUrl ?? "");
            if (response.redirect)
                window.location.href = response.redirect;
        }
        catch (error) {
            showFeedback(error instanceof Error ? error.message : "应用失败。", true);
        }
    });
    root.querySelector("#planning-copy-pending")?.addEventListener("click", async () => {
        const text = (result.issues ?? []).map((issue) => issue.message ?? issue.code ?? "尚待确定事项").join("\n") || "暂无待确认事项。";
        try {
            await navigator.clipboard?.writeText(text);
        }
        catch {
            const textarea = document.createElement("textarea");
            textarea.value = text;
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand("copy");
            textarea.remove();
        }
        showFeedback("尚待确定事项已复制。");
    });
    renderStages();
})();
