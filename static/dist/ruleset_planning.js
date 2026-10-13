"use strict";
(() => {
    "use strict";
    let idCounter = 0;
    function stableId(prefix) {
        const cryptoObject = window.crypto;
        if (typeof cryptoObject?.randomUUID === "function")
            return `${prefix}-${cryptoObject.randomUUID()}`;
        idCounter += 1;
        return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
    }
    function planningField(value, unit, resolution = "pending") {
        return { value, resolution, evidence: "工作人员填写", unit };
    }
    function emptyRubric() {
        return { name: planningField("", "text"), description: planningField("", "text", "confirmed"), criteria: [] };
    }
    function clonePayload(payload) {
        return JSON.parse(JSON.stringify(payload));
    }
    function buildPlanningPayload(payload) {
        const next = clonePayload(payload);
        next.schema_version = 1;
        next.execution_refs = next.execution_refs ?? {};
        next.stages = Array.isArray(next.stages) ? next.stages : [];
        next.stages.forEach((stage) => {
            stage.judge_sources = Array.isArray(stage.judge_sources) ? stage.judge_sources : [];
            stage.judge_sources.forEach((round) => {
                if (typeof round.weight?.value === "number")
                    round.weight.value = String(round.weight.value);
                if (typeof round.judge_count?.value === "number")
                    round.judge_count.value = String(round.judge_count.value);
                if (typeof round.minimum_judge_count?.value === "number")
                    round.minimum_judge_count.value = String(round.minimum_judge_count.value);
                round.rubric = round.rubric ?? emptyRubric();
                round.rubric.criteria = Array.isArray(round.rubric.criteria) ? round.rubric.criteria : [];
            });
            if (typeof stage.audience_weight?.value === "number")
                stage.audience_weight.value = String(stage.audience_weight.value);
            if (typeof stage.previous_weight?.value === "number")
                stage.previous_weight.value = String(stage.previous_weight.value);
        });
        return next;
    }
    function addStage(payload, options = {}) {
        payload.execution_refs = payload.execution_refs ?? {};
        const hasName = Boolean(options.name?.trim());
        const stage = {
            business_id: stableId("stage"),
            name: planningField(options.name?.trim() ?? "", "text", hasName ? "confirmed" : "pending"),
            participants: { source: "", count: planningField(null, "person"), group_count: planningField("", "group", "confirmed"), group_size: planningField("", "person", "confirmed") },
            collaboration_group: planningField("", "group", "confirmed"),
            advance_count: planningField(null, "person"),
            result_method: planningField(null, "text"),
            previous_weight: planningField(null, "percent"),
            judge_sources: [],
            audience_weight: planningField(null, "percent"),
            audience_source: planningField("", "vote", "confirmed"),
            audience_conversion: planningField("", "text", "confirmed"),
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
        const hasName = Boolean(options.name?.trim());
        const round = {
            business_id: businessId,
            round_key: businessId,
            name: planningField(options.name?.trim() ?? "", "text", hasName ? "confirmed" : "pending"),
            format: options.format ?? "",
            weight: planningField(null, "percent"),
            scoring_mode: planningField(null, "text"),
            judge_count: planningField(null, "judge"),
            minimum_judge_count: planningField("", "judge", "confirmed"),
            rubric: emptyRubric(),
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
    function previewState(response) {
        if (!response.ok || !response.result)
            return { canApply: false, message: response.error ?? "预览失败，请检查当前状态。" };
        const result = response.result;
        if (!result.can_apply) {
            return result.business_complete && !result.binding_ready
                ? { canApply: false, message: "业务内容已填写，但活动绑定尚未准备好。" }
                : { canApply: false, message: "候选方案仍有尚待确定事项。" };
        }
        return result.freeze_ready === false
            ? { canApply: true, message: "候选方案可以安全应用，但正式冻结前仍需完成检查。" }
            : { canApply: true, message: "候选方案已准备，可以继续应用。" };
    }
    function pendingIssueText(issues) {
        return issues.map((issue) => issue.message ?? issue.code ?? "尚待确定事项").join("\n") || "暂无待确认事项。";
    }
    const api = { buildPlanningPayload, formatPercentageTotal, addStage, removeStage, addRound, previewState, pendingIssueText };
    window.ArtFlowRulesetPlanning = api;
    const root = document.querySelector("#ruleset-planning-app");
    if (!root)
        return;
    const payloadElement = document.querySelector("#ruleset-planning-payload");
    if (!payloadElement?.textContent)
        return;
    let payload = buildPlanningPayload(JSON.parse(payloadElement.textContent));
    const revisionState = { value: Number.parseInt(root.dataset.revision ?? "0", 10) || 0 };
    const stageList = root.querySelector("#planning-stage-list");
    const stageCount = root.querySelector("#planning-stage-count");
    const feedback = root.querySelector("#planning-feedback");
    const pending = root.querySelector("#planning-pending");
    const summary = root.querySelector("#planning-live-summary");
    const resultElement = document.querySelector("#ruleset-planning-result");
    let latestResult = resultElement?.textContent ? JSON.parse(resultElement.textContent) : {};
    let latestIssues = latestResult.issues ?? [];
    const csrfToken = root.querySelector("[name='csrfmiddlewaretoken']")?.value ?? "";
    const readOnly = root.dataset.readOnly === "true";
    function fieldValue(field, fallback = "") {
        if (!field || field.value === null || field.value === undefined)
            return fallback;
        return String(field.value);
    }
    function ensureField(field, unit) { return field ?? planningField(null, unit); }
    function ensureOptionalField(field, unit) {
        return field ?? planningField("", unit, "confirmed");
    }
    function updateField(field, value, unit = field.unit) {
        field.value = value;
        field.unit = unit;
        field.resolution = value.trim() ? "confirmed" : "pending";
        field.evidence = "工作人员填写";
    }
    function makeInput(value, label, unit, onInput, type = "text") {
        const labelElement = document.createElement("label");
        labelElement.className = "block text-sm text-gray-700";
        labelElement.textContent = unit ? `${label}（${unit}）` : label;
        const input = document.createElement("input");
        input.type = type;
        input.className = "mt-1 w-full border border-gray-300 rounded px-3 py-2";
        input.value = value;
        input.placeholder = unit === "%" ? "例如 30" : "请填写";
        input.addEventListener("input", () => onInput(input.value));
        labelElement.appendChild(input);
        return labelElement;
    }
    function makeSelect(value, label, options, onChange) {
        const labelElement = document.createElement("label");
        labelElement.className = "block text-sm text-gray-700";
        labelElement.textContent = label;
        const select = document.createElement("select");
        select.className = "mt-1 w-full border border-gray-300 rounded px-3 py-2";
        options.forEach(([optionValue, optionLabel]) => {
            const option = document.createElement("option");
            option.value = optionValue;
            option.textContent = optionLabel;
            option.selected = optionValue === value;
            select.appendChild(option);
        });
        select.addEventListener("change", () => onChange(select.value));
        labelElement.appendChild(select);
        return labelElement;
    }
    function renderPending() {
        if (!pending)
            return;
        pending.replaceChildren();
        if (!latestIssues.length) {
            pending.textContent = "暂无待确认事项。";
            return;
        }
        const list = document.createElement("ul");
        list.className = "list-disc pl-5 space-y-1";
        latestIssues.forEach((issue) => {
            const item = document.createElement("li");
            item.textContent = issue.message ?? issue.code ?? "尚待确定事项";
            list.appendChild(item);
        });
        pending.appendChild(list);
    }
    function renderSummary() {
        if (!summary)
            return;
        summary.replaceChildren();
        const status = document.createElement("p");
        status.className = latestResult.can_apply ? "text-green-700" : "text-amber-800";
        status.textContent = latestResult.can_apply ? "业务信息完整，候选方案可以应用。" : "候选方案尚未满足应用条件。";
        summary.appendChild(status);
        (latestResult.change_summary ?? []).forEach((change) => {
            const item = document.createElement("p");
            item.className = "mt-1 text-sm text-gray-700";
            item.textContent = change;
            summary.appendChild(item);
        });
    }
    function stageTotal(stage) {
        const values = stage.judge_sources.map((round) => `${fieldValue(round.weight)}%`);
        values.push(`${fieldValue(ensureField(stage.previous_weight, "percent"))}%`, `${fieldValue(stage.audience_weight)}%`);
        return formatPercentageTotal(values);
    }
    function renderRubric(round, container) {
        const rubric = round.rubric ?? emptyRubric();
        round.rubric = rubric;
        const rubricBox = document.createElement("div");
        rubricBox.className = "sm:col-span-2 border-t border-gray-100 pt-3 space-y-2";
        rubricBox.appendChild(makeInput(fieldValue(rubric.name), "评分表名称", "", (value) => updateField(rubric.name, value, "text")));
        rubricBox.appendChild(makeInput(fieldValue(rubric.description), "评分表说明", "", (value) => updateField(rubric.description, value, "text")));
        const title = document.createElement("p");
        title.className = "text-sm font-medium text-gray-700";
        title.textContent = "评分维度与满分（总和必须为 100 分）";
        rubricBox.appendChild(title);
        rubric.criteria.forEach((criterion, index) => {
            const row = document.createElement("div");
            row.className = "grid gap-2 sm:grid-cols-[1fr_10rem_auto]";
            row.appendChild(makeInput(fieldValue(criterion.name), `评分维度 ${index + 1}`, "", (value) => updateField(criterion.name, value, "text")));
            row.appendChild(makeInput(fieldValue(criterion.max_score), "满分", "分", (value) => updateField(criterion.max_score, value, "score"), "number"));
            const remove = document.createElement("button");
            remove.type = "button";
            remove.className = "self-end text-sm text-red-700 pb-2";
            remove.textContent = "删除维度";
            remove.addEventListener("click", () => { rubric.criteria.splice(index, 1); renderStages(); });
            row.appendChild(remove);
            rubricBox.appendChild(row);
        });
        const addCriterion = document.createElement("button");
        addCriterion.type = "button";
        addCriterion.className = "border border-gray-300 rounded px-3 py-1.5 text-sm";
        addCriterion.textContent = "添加评分维度";
        addCriterion.addEventListener("click", () => {
            rubric.criteria.push({ name: planningField("", "text"), max_score: planningField(null, "score") });
            renderStages();
        });
        rubricBox.appendChild(addCriterion);
        container.appendChild(rubricBox);
    }
    function renderStages() {
        if (!stageList)
            return;
        stageList.replaceChildren();
        payload.stages.forEach((stage, index) => {
            stage.previous_weight = ensureField(stage.previous_weight, "percent");
            stage.audience_weight = ensureField(stage.audience_weight, "percent");
            stage.audience_source = ensureOptionalField(stage.audience_source, "vote");
            stage.audience_conversion = ensureOptionalField(stage.audience_conversion, "text");
            stage.judge_sources = Array.isArray(stage.judge_sources) ? stage.judge_sources : [];
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
            remove.addEventListener("click", () => { removeStage(payload, stage.business_id); renderStages(); });
            heading.append(title, remove);
            card.appendChild(heading);
            const grid = document.createElement("div");
            grid.className = "grid gap-3 sm:grid-cols-2";
            grid.appendChild(makeInput(fieldValue(stage.name), "阶段名称", "", (value) => updateField(stage.name, value, "text")));
            grid.appendChild(makeInput(fieldValue(stage.advance_count), "晋级人数", "人", (value) => updateField(stage.advance_count, value, "person"), "number"));
            grid.appendChild(makeSelect(fieldValue(stage.result_method), "晋级方式", [["", "尚待确定"], ["top_n", "按前 N 名晋级"], ["manual_review", "人工确认晋级"]], (value) => updateField(stage.result_method, value, "text")));
            const participants = stage.participants ?? { source: "", count: planningField(null, "person"), group_count: planningField("", "group", "confirmed"), group_size: planningField("", "person", "confirmed") };
            stage.participants = participants;
            grid.appendChild(makeInput(fieldValue(participants.count), "参赛人数", "人", (value) => updateField(participants.count, value, "person"), "number"));
            grid.appendChild(makeInput(fieldValue(participants.group_count), "演唱组数", "组", (value) => updateField(participants.group_count ?? (participants.group_count = planningField("", "group", "confirmed")), value, "group"), "number"));
            grid.appendChild(makeInput(fieldValue(participants.group_size), "每组人数", "人", (value) => updateField(participants.group_size ?? (participants.group_size = planningField("", "person", "confirmed")), value, "person"), "number"));
            grid.appendChild(makeInput(fieldValue(stage.collaboration_group), "合作演唱说明", "", (value) => updateField(stage.collaboration_group ?? (stage.collaboration_group = planningField("", "group", "confirmed")), value, "group")));
            grid.appendChild(makeInput(fieldValue(stage.previous_weight), "上一阶段成绩", "%", (value) => updateField(stage.previous_weight, value, "percent"), "number"));
            grid.appendChild(makeInput(fieldValue(stage.audience_weight), "观众成绩", "%", (value) => updateField(stage.audience_weight, value, "percent"), "number"));
            grid.appendChild(makeInput(fieldValue(stage.audience_source), "观众投票/成绩来源", "", (value) => updateField(stage.audience_source, value, "vote")));
            grid.appendChild(makeSelect(fieldValue(stage.audience_conversion), "观众投票与成绩换算", [["", "尚待确定"], ["ballot_share_percent", "有效票支持率（0-100）"], ["audience_score_hundred", "百分制观众分"]], (value) => updateField(stage.audience_conversion, value, "text")));
            card.appendChild(grid);
            const rounds = document.createElement("div");
            rounds.className = "space-y-3 border-t border-gray-100 pt-3";
            const roundsTitle = document.createElement("p");
            roundsTitle.className = "font-medium text-gray-800";
            roundsTitle.textContent = "评分轮次";
            rounds.appendChild(roundsTitle);
            stage.judge_sources.forEach((round, roundIndex) => {
                round.scoring_mode = ensureField(round.scoring_mode, "text");
                round.judge_count = ensureField(round.judge_count, "judge");
                round.minimum_judge_count = ensureOptionalField(round.minimum_judge_count, "judge");
                round.rubric = round.rubric ?? emptyRubric();
                const row = document.createElement("div");
                row.className = "grid gap-2 sm:grid-cols-2";
                row.appendChild(makeInput(fieldValue(round.name), `第 ${roundIndex + 1} 轮名称`, "", (value) => updateField(round.name, value, "text")));
                row.appendChild(makeInput(fieldValue(round.weight), "成绩比例", "%", (value) => updateField(round.weight, value, "percent"), "number"));
                row.appendChild(makeSelect(round.format, "演唱形式", [["", "尚待确定"], ["solo", "独唱"], ["collaboration", "合作演唱（每人分别评分）"]], (value) => { round.format = value; }));
                row.appendChild(makeSelect(fieldValue(round.scoring_mode), "评分方式", [["", "尚待确定"], ["average", "评委平均分"], ["drop_high_low", "去掉最高分和最低分"]], (value) => updateField(round.scoring_mode, value, "text")));
                row.appendChild(makeInput(fieldValue(round.judge_count), "评委数量", "人", (value) => updateField(round.judge_count, value, "judge"), "number"));
                row.appendChild(makeInput(fieldValue(round.minimum_judge_count), "最低有效评委", "人", (value) => updateField(round.minimum_judge_count, value, "judge"), "number"));
                const remove = document.createElement("button");
                remove.type = "button";
                remove.className = "text-sm text-red-700 sm:col-span-2 justify-self-start";
                remove.textContent = "删除评分轮次";
                remove.addEventListener("click", () => { stage.judge_sources.splice(roundIndex, 1); renderStages(); });
                row.appendChild(remove);
                rounds.appendChild(row);
                renderRubric(round, rounds);
            });
            const total = document.createElement("p");
            total.className = "text-sm text-gray-600";
            total.textContent = `本阶段比例：${stageTotal(stage).label}`;
            rounds.appendChild(total);
            const addRoundButton = document.createElement("button");
            addRoundButton.type = "button";
            addRoundButton.className = "border border-gray-300 rounded px-3 py-1.5 text-sm";
            addRoundButton.textContent = "添加评分轮次";
            addRoundButton.addEventListener("click", () => { addRound(stage); renderStages(); });
            rounds.appendChild(addRoundButton);
            card.appendChild(rounds);
            stageList.appendChild(card);
        });
        if (stageCount)
            stageCount.textContent = String(payload.stages.length);
        renderPending();
        renderSummary();
    }
    function showFeedback(message, isError = false) {
        if (!feedback)
            return;
        feedback.className = isError ? "mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" : "mb-5 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800";
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
            throw new Error(body.error ?? "请求失败，请检查尚待确定事项。");
        return body;
    }
    root.querySelector("#planning-add-stage")?.addEventListener("click", () => { addStage(payload); renderStages(); });
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
            latestResult = response.result ?? {};
            latestIssues = latestResult.issues ?? [];
            renderPending();
            renderSummary();
            const state = previewState(response);
            showFeedback(state.message, !state.canApply);
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
            const preview = await post(root.dataset.previewUrl ?? "");
            latestResult = preview.result ?? {};
            latestIssues = latestResult.issues ?? [];
            renderPending();
            renderSummary();
            const state = previewState(preview);
            if (!state.canApply) {
                showFeedback(state.message, true);
                return;
            }
            const response = await post(root.dataset.applyUrl ?? "");
            if (response.redirect)
                window.location.href = response.redirect;
        }
        catch (error) {
            showFeedback(error instanceof Error ? error.message : "应用失败。", true);
        }
    });
    root.querySelector("#planning-copy-pending")?.addEventListener("click", async () => {
        const text = pendingIssueText(latestIssues);
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
    if (!readOnly)
        renderStages();
    else {
        renderPending();
        renderSummary();
    }
})();
