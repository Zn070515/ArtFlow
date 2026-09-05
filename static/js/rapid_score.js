(function () {
  "use strict";

  var container = document.getElementById("rapid-entry");
  if (!container) return;

  var apiUrl = container.dataset.apiUrl;
  var activityId = parseInt(container.dataset.activityId, 10);
  var roundId = parseInt(container.dataset.roundId, 10);
  var locked = container.dataset.locked === "true";
  var csrf = document.querySelector('[name="csrfmiddlewaretoken"]');
  var csrfToken = csrf ? csrf.value : "";

  var dataEl = document.getElementById("rapid-grid-data");
  var initial = dataEl ? JSON.parse(dataEl.textContent || "{}") : {};

  var tbody = container.querySelector("tbody");
  var progressFill = container.querySelector("[data-progress-fill]");
  var progressText = container.querySelector("[data-progress-text]");
  var versionEl = container.querySelector("[data-version]");
  var resolvedEl = container.querySelector("[data-resolved]");
  var errorBox = container.querySelector("[data-error]");
  var retryButton = container.querySelector("[data-retry]");
  var pendingCountEl = container.querySelector("[data-pending-count]");
  var savedCountEl = container.querySelector("[data-saved-count]");
  var conflictsEl = container.querySelector("[data-conflicts]");
  var pendingStorageKey = "artflow:rapid-score:pending:" + activityId + ":" + roundId + ":" + apiUrl;

  var state = {
    version: initial.version || 0,
    cells: {},
    dirty: {},
    total: 0,
    filled: 0,
    locked: locked,
    draftCommandId: null,
    draftBaseVersion: null,
    conflicts: {},
  };

  function key(singerId, judgeId) {
    return singerId + ":" + judgeId;
  }

  function initCells(grid) {
    state.cells = {};
    (grid || []).forEach(function (row) {
      row.cells.forEach(function (cell) {
        state.cells[key(row.singer_id, cell.judge_id)] = cell.score || "";
      });
    });
    state.total = Object.keys(state.cells).length;
  }

  function inputFor(singerId, judgeId) {
    if (!tbody) return null;
    return tbody.querySelector(
      'input[data-singer-id="' + singerId + '"][data-judge-id="' + judgeId + '"]'
    );
  }

  function recountFilled() {
    var filled = 0;
    for (var k in state.cells) {
      if (state.cells[k] !== "") filled++;
    }
    state.filled = filled;
  }

  function updateProgress() {
    recountFilled();
    var pct = state.total ? Math.round((state.filled / state.total) * 100) : 0;
    if (progressFill) progressFill.style.width = pct + "%";
    if (progressText) progressText.textContent = state.filled + " / " + state.total;
    if (savedCountEl) savedCountEl.textContent = String(state.filled);
  }

  function updatePendingCount() {
    if (pendingCountEl) pendingCountEl.textContent = String(Object.keys(state.dirty).length);
  }

  function setVersion(v) {
    state.version = v;
    if (versionEl) versionEl.textContent = "#" + v;
  }

  function setResolved(status) {
    if (resolvedEl) resolvedEl.textContent = status || "未计算";
  }

  function showError(msg) {
    if (!errorBox) return;
    errorBox.textContent = msg;
    errorBox.classList.remove("hidden");
  }

  function clearError() {
    if (!errorBox) return;
    errorBox.textContent = "";
    errorBox.classList.add("hidden");
  }

  function renderConflicts() {
    var keys = Object.keys(state.conflicts);
    if (!conflictsEl) return;
    if (!keys.length) {
      conflictsEl.textContent = "";
      conflictsEl.classList.add("hidden");
      return;
    }
    conflictsEl.textContent = keys.map(function (k) {
      var conflict = state.conflicts[k];
      return "选手 " + conflict.singer_id + "、评委 " + conflict.judge_id +
        "：服务器为 " + conflict.server + "，本机草稿为 " + conflict.local +
        "。请修改该单元格后再重试保存，以明确选择。";
    }).join(" ");
    conflictsEl.classList.remove("hidden");
  }

  var SCORE_RE = /^\s*\d{1,3}(\.\d{1,2})?\s*$/;
  function scoreState(value) {
    var v = value.trim();
    if (v === "") return "empty";
    if (!SCORE_RE.test(v)) return "invalid";
    var n = parseFloat(v);
    if (n < 0 || n > 100) return "invalid";
    return "valid";
  }

  function setVisual(input, bad) {
    input.style.borderColor = bad ? "#ef4444" : "#d1d5db";
    input.style.boxShadow = bad ? "0 0 0 1px #ef4444" : "none";
    input.style.background = bad ? "#fef2f2" : "";
  }

  function onInput(event) {
    var input = event.target;
    if (state.locked || input.disabled) return;
    var value = input.value;
    var s = scoreState(value);
    if (s === "invalid") {
      setVisual(input, true);
      return;
    }
    setVisual(input, false);
    var k = key(input.dataset.singerId, input.dataset.judgeId);
    if (s === "empty") {
      delete state.dirty[k];
      delete state.conflicts[k];
      persistDraft();
      updatePendingCount();
      renderConflicts();
      scheduleSave();
      return;
    }
    state.dirty[k] = value.trim();
    delete state.conflicts[k];
    state.draftCommandId = newCommandId();
    state.draftBaseVersion = state.version;
    persistDraft();
    updatePendingCount();
    renderConflicts();
    scheduleSave();
  }

  var saveTimer = null;
  var retryTimer = null;
  var retryAttempt = 0;
  var saveInflight = false;

  function newCommandId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return "rapid-" + window.crypto.randomUUID();
    }
    return "rapid-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 14);
  }

  function localStorageOrNull() {
    try {
      return window.localStorage || null;
    } catch (error) {
      return null;
    }
  }

  function cellsFromDirty() {
    return Object.keys(state.dirty).sort().map(function (k) {
      var p = k.split(":");
      return {
        singer_id: parseInt(p[0], 10),
        judge_id: parseInt(p[1], 10),
        score: state.dirty[k],
      };
    });
  }

  function validPendingCells(cells) {
    return Array.isArray(cells) && cells.length > 0 && cells.every(function (cell) {
      return cell && Number.isInteger(cell.singer_id) && cell.singer_id > 0 &&
        Number.isInteger(cell.judge_id) && cell.judge_id > 0 &&
        typeof cell.score === "string" && scoreState(cell.score) === "valid";
    });
  }

  function validScoreOrEmpty(value) {
    return typeof value === "string" && (value === "" || scoreState(value) === "valid");
  }

  function conflictRecords(cells) {
    var pendingByKey = {};
    cells.forEach(function (cell) {
      pendingByKey[key(cell.singer_id, cell.judge_id)] = cell.score;
    });
    return Object.keys(state.conflicts).sort().map(function (k) {
      var conflict = state.conflicts[k];
      return {
        singer_id: parseInt(conflict.singer_id, 10),
        judge_id: parseInt(conflict.judge_id, 10),
        base: conflict.base,
        server: conflict.server,
        local: pendingByKey[k],
      };
    });
  }

  function validPendingConflicts(conflicts, cells) {
    if (conflicts === undefined) return true;
    if (!Array.isArray(conflicts)) return false;
    var pendingByKey = {};
    cells.forEach(function (cell) {
      pendingByKey[key(cell.singer_id, cell.judge_id)] = cell.score;
    });
    var seen = {};
    return conflicts.every(function (conflict) {
      if (!conflict || !Number.isInteger(conflict.singer_id) || conflict.singer_id <= 0 ||
        !Number.isInteger(conflict.judge_id) || conflict.judge_id <= 0 ||
        !validScoreOrEmpty(conflict.base) || !validScoreOrEmpty(conflict.server) ||
        typeof conflict.local !== "string" || scoreState(conflict.local) !== "valid") {
        return false;
      }
      var conflictKey = key(conflict.singer_id, conflict.judge_id);
      if (seen[conflictKey] || pendingByKey[conflictKey] !== conflict.local) return false;
      seen[conflictKey] = true;
      return true;
    });
  }

  function pendingRecord(commandId) {
    var cells = cellsFromDirty();
    if (!validPendingCells(cells)) return null;
    var conflicts = conflictRecords(cells);
    if (!validPendingConflicts(conflicts, cells)) return null;
    var baseVersion = state.draftBaseVersion;
    if (!Number.isInteger(baseVersion) || baseVersion < 0) baseVersion = state.version;
    commandId = commandId || state.draftCommandId || newCommandId();
    if (typeof commandId !== "string" || !commandId || commandId.length > 64) return null;
    state.draftCommandId = commandId;
    state.draftBaseVersion = baseVersion;
    var record = {
      activity: activityId,
      round: roundId,
      endpoint: apiUrl,
      base_version: baseVersion,
      cells: cells,
      command_id: commandId,
      updated_at: new Date().toISOString(),
    };
    if (conflicts.length) record.conflicts = conflicts;
    return record;
  }

  function persistDraft(commandId) {
    var storage = localStorageOrNull();
    var record = pendingRecord(commandId);
    if (!storage) return record;
    try {
      if (record) storage.setItem(pendingStorageKey, JSON.stringify(record));
      else if (!Object.keys(state.dirty).length) storage.removeItem(pendingStorageKey);
    } catch (error) {
      // Storage is a convenience for a client draft; quota/privacy failures do not block scoring.
    }
    return record;
  }

  function clearPendingAfterAck(commandId) {
    var storage = localStorageOrNull();
    if (!storage) return;
    try {
      var saved = JSON.parse(storage.getItem(pendingStorageKey) || "null");
      if (saved && saved.command_id === commandId && !Object.keys(state.dirty).length) {
        storage.removeItem(pendingStorageKey);
      }
    } catch (error) {
      // A malformed browser draft is never authoritative and is ignored.
    }
  }

  function validPendingRecord(record) {
    return record && record.activity === activityId && record.round === roundId &&
      record.endpoint === apiUrl && Number.isInteger(record.base_version) && record.base_version >= 0 &&
      typeof record.command_id === "string" && record.command_id.length > 0 &&
      record.command_id.length <= 64 && typeof record.updated_at === "string" &&
      validPendingCells(record.cells) && validPendingConflicts(record.conflicts, record.cells);
  }

  function restorePendingDraft() {
    var storage = localStorageOrNull();
    if (!storage) return;
    try {
      var record = JSON.parse(storage.getItem(pendingStorageKey) || "null");
      if (!validPendingRecord(record)) return;
      state.draftCommandId = record.command_id;
      state.draftBaseVersion = record.base_version;
      record.cells.forEach(function (cell) {
        var k = key(cell.singer_id, cell.judge_id);
        if (!(k in state.cells)) return;
        state.dirty[k] = cell.score;
        var input = inputFor(cell.singer_id, cell.judge_id);
        if (input) {
          input.value = cell.score;
          setVisual(input, false);
        }
      });
      (record.conflicts || []).forEach(function (conflict) {
        var conflictKey = key(conflict.singer_id, conflict.judge_id);
        state.conflicts[conflictKey] = {
          singer_id: conflict.singer_id,
          judge_id: conflict.judge_id,
          base: conflict.base,
          server: conflict.server,
          local: conflict.local,
        };
      });
    } catch (error) {
      // Ignore an untrusted or malformed local draft instead of inventing score facts.
    }
  }

  function scheduleSave() {
    if (state.locked) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 500);
  }

  function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (state.locked) return;
    if (!Object.keys(state.dirty).length) return;
    if (Object.keys(state.conflicts).length) {
      showError("存在同一单元格的并发冲突；请先修改冲突单元格后再保存。");
      return;
    }
    var record = persistDraft();
    if (!record) return;
    if (navigator.onLine === false) {
      showError("当前离线，评分草稿已保留，联网后将重试。");
      return;
    }
    savePending(record);
  }

  function scheduleRetry(commandId) {
    retryAttempt = Math.min(retryAttempt + 1, 4);
    var delay = Math.min(1000 * Math.pow(2, retryAttempt - 1), 8000);
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(function () {
      retryTimer = null;
      if (navigator.onLine !== false && state.draftCommandId === commandId) flushSave();
    }, delay);
  }

  function savePending(record) {
    if (saveInflight) {
      return;
    }
    saveInflight = true;
    var payload = JSON.stringify({
      command_id: record.command_id,
      base_version: record.base_version,
      cells: record.cells,
    });
    fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRFToken": csrfToken },
      body: payload,
    })
      .then(function (resp) {
        return resp.json().then(function (data) {
          return { status: resp.status, data: data };
        });
      })
      .then(function (r) {
        if (r.status === 200) {
          setVersion(r.data.version);
          record.cells.forEach(function (c) {
            var k = key(c.singer_id, c.judge_id);
            state.cells[k] = c.score;
            if (state.dirty[k] === c.score) delete state.dirty[k];
            delete state.conflicts[k];
          });
          retryAttempt = 0;
          if (!Object.keys(state.dirty).length) {
            state.draftCommandId = null;
            state.draftBaseVersion = null;
          }
          clearPendingAfterAck(record.command_id);
          persistDraft();
          clearError();
          updateProgress();
          updatePendingCount();
          renderConflicts();
          if (r.data.matrix_complete) setResolved(r.data.resolved_status);
        } else if (r.status === 409) {
          if (r.data.reason_code === "IDEMPOTENCY_CONFLICT") {
            showError("本次保存请求冲突；请刷新后重试。");
          } else {
            showError("数据已过期（他人已更新）；本机草稿已与最新数据比较。");
            refreshFromServer();
          }
        } else if (r.status === 400) {
          showError(flattenDetail(r.data.detail));
          // A validation response is not an acknowledgement. Keep the client draft
          // visible and retryable so a changed roster or a corrected value is not lost.
        } else if (r.status === 403) {
          showError("无权限：" + flattenDetail(r.data.detail));
        } else {
          showError("保存失败（HTTP " + r.status + "）。");
        }
      })
      .catch(function () {
        showError("网络错误，保存失败，请稍后重试。");
        scheduleRetry(record.command_id);
      })
      .finally(function () {
        saveInflight = false;
        if (state.draftCommandId && state.draftCommandId !== record.command_id) {
          flushSave();
        }
      });
  }

  function flattenDetail(detail) {
    if (!detail) return "保存失败。";
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) return detail.join("；");
    return JSON.stringify(detail);
  }

  function refreshFromServer() {
    fetch(apiUrl, { method: "GET" })
      .then(function (resp) {
        return resp.json();
      })
      .then(function (data) {
        var beforeRefresh = {};
        var localDraft = {};
        for (var dirtyKey in state.dirty) {
          beforeRefresh[dirtyKey] = state.cells[dirtyKey] || "";
          localDraft[dirtyKey] = state.dirty[dirtyKey];
        }
        setVersion(data.version);
        initCells(data.grid);
        (data.grid || []).forEach(function (row) {
          row.cells.forEach(function (cell) {
            var inp = inputFor(row.singer_id, cell.judge_id);
            if (inp) {
              inp.value = cell.score || "";
              setVisual(inp, false);
            }
          });
        });
        state.conflicts = {};
        for (var k in localDraft) {
          var parts = k.split(":");
          var serverValue = state.cells[k] || "";
          var localValue = localDraft[k];
          var input = inputFor(parts[0], parts[1]);
          if (serverValue !== beforeRefresh[k] && serverValue !== localValue) {
            state.conflicts[k] = {
              singer_id: parts[0],
              judge_id: parts[1],
              base: beforeRefresh[k],
              server: serverValue,
              local: localValue,
            };
          }
          if (input) {
            input.value = localValue;
            setVisual(input, false);
          }
        }
        if (Object.keys(localDraft).length) {
          state.draftBaseVersion = data.version;
          persistDraft(state.draftCommandId);
        }
        updateProgress();
        updatePendingCount();
        renderConflicts();
        setResolved(data.matrix_complete ? data.resolved_status : null);
      })
      .catch(function () {
        showError("无法获取最新评分；本机草稿仍已保留，请稍后重试。");
      });
  }

  function applyCellValue(input, value) {
    if (!input) return;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function moveTo(nextInput) {
    if (!nextInput) return;
    flushSave();
    nextInput.focus();
    nextInput.select();
  }

  function onKeydown(event) {
    if (state.locked) return;
    var input = event.target;
    if (input.tagName !== "INPUT") return;
    var judgeId = input.dataset.judgeId;
    var row = input.closest("tr");
    if (!row) return;

    if (event.key === "Enter" || event.key === "ArrowDown") {
      event.preventDefault();
      var nextRow = row.nextElementSibling;
      if (nextRow) moveTo(nextRow.querySelector('input[data-judge-id="' + judgeId + '"]'));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      var cols = row.querySelectorAll("input[data-judge-id]");
      var idx = Array.prototype.indexOf.call(cols, input);
      if (idx < cols.length - 1) moveTo(cols[idx + 1]);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      var cols2 = row.querySelectorAll("input[data-judge-id]");
      var idx2 = Array.prototype.indexOf.call(cols2, input);
      if (idx2 > 0) moveTo(cols2[idx2 - 1]);
    } else if (event.key === "Escape") {
      var k = key(input.dataset.singerId, input.dataset.judgeId);
      input.value = state.cells[k] || "";
      setVisual(input, false);
      delete state.dirty[k];
      delete state.conflicts[k];
      persistDraft();
      updatePendingCount();
      renderConflicts();
      input.blur();
    }
  }

  function onPaste(event) {
    if (state.locked) return;
    var input = event.target;
    if (input.tagName !== "INPUT") return;
    var text = (event.clipboardData || window.clipboardData).getData("text");
    if (!text) return;
    var hasTab = text.indexOf("\t") !== -1;
    var lines = text.split(/\r?\n/).map(function (l) {
      return l.replace(/\s+$/g, "");
    });
    if (!hasTab && lines.length === 1) return; // single value: let normal typing handle it
    event.preventDefault();

    var rows = Array.prototype.slice.call(tbody.querySelectorAll("tr"));
    var cols = input.closest("tr").querySelectorAll("input[data-judge-id]");
    var startRow = rows.indexOf(input.closest("tr"));
    var startCol = Array.prototype.indexOf.call(cols, input);

    for (var r = 0; r < lines.length; r++) {
      var line = lines[r];
      if (line === "") continue;
      var values = line.split("\t");
      for (var c = 0; c < values.length; c++) {
        var val = values[c].replace(/\s+/g, "");
        if (val === "") continue;
        var target = rows[startRow + r];
        var idx = startCol + c;
        if (target && idx >= 0 && idx < cols.length) {
          applyCellValue(target.querySelectorAll("input[data-judge-id]")[idx], val);
        }
      }
    }
  }

  function onBlur(event) {
    if (event.target.tagName === "INPUT") flushSave();
  }

  if (!state.locked && tbody) {
    tbody.addEventListener("input", onInput);
    tbody.addEventListener("keydown", onKeydown);
    tbody.addEventListener("paste", onPaste);
    tbody.addEventListener("blur", onBlur, true);
  }

  if (!state.locked && retryButton) {
    retryButton.addEventListener("click", function () {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      flushSave();
    });
  }

  if (!state.locked) {
    window.addEventListener("online", function () {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      flushSave();
    });
    window.addEventListener("beforeunload", function (event) {
      if (!Object.keys(state.dirty).length) return;
      event.preventDefault();
      event.returnValue = "仍有未保存的评分草稿。";
      return event.returnValue;
    });
  }

  initCells(initial.grid);
  restorePendingDraft();
  updateProgress();
  updatePendingCount();
  renderConflicts();
  setVersion(state.version);
})();
