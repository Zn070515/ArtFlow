(function () {
  "use strict";

  var container = document.getElementById("rapid-entry");
  if (!container) return;

  var apiUrl = container.dataset.apiUrl;
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

  var state = {
    version: initial.version || 0,
    cells: {},
    dirty: {},
    total: 0,
    filled: 0,
    locked: locked,
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
      scheduleSave();
      return;
    }
    state.dirty[k] = value.trim();
    scheduleSave();
  }

  var saveTimer = null;
  var saveInflight = false;
  var queued = null;

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
    var keys = Object.keys(state.dirty);
    if (!keys.length) return;
    var cells = keys.map(function (k) {
      var p = k.split(":");
      return { singer_id: parseInt(p[0], 10), judge_id: parseInt(p[1], 10), score: state.dirty[k] };
    });
    savePending(cells);
  }

  function savePending(cells) {
    if (saveInflight) {
      queued = cells;
      return;
    }
    saveInflight = true;
    var payload = JSON.stringify({ base_version: state.version, cells: cells });
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
          cells.forEach(function (c) {
            var k = key(c.singer_id, c.judge_id);
            state.cells[k] = c.score;
            delete state.dirty[k];
          });
          clearError();
          updateProgress();
          if (r.data.matrix_complete) setResolved(r.data.resolved_status);
        } else if (r.status === 409) {
          showError("数据已过期（他人已更新），已刷新到最新。");
          refreshFromServer();
        } else if (r.status === 400) {
          showError(flattenDetail(r.data.detail));
          cells.forEach(function (c) {
            var k = key(c.singer_id, c.judge_id);
            var inp = inputFor(c.singer_id, c.judge_id);
            if (inp) {
              inp.value = state.cells[k] || "";
              setVisual(inp, false);
            }
            delete state.dirty[k];
          });
          updateProgress();
        } else if (r.status === 403) {
          showError("无权限：" + flattenDetail(r.data.detail));
        } else {
          showError("保存失败（HTTP " + r.status + "）。");
        }
      })
      .catch(function () {
        showError("网络错误，保存失败，请稍后重试。");
      })
      .finally(function () {
        saveInflight = false;
        if (queued) {
          var next = queued;
          queued = null;
          savePending(next);
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
        setVersion(data.version);
        initCells(data.grid);
        state.dirty = {};
        (data.grid || []).forEach(function (row) {
          row.cells.forEach(function (cell) {
            var inp = inputFor(row.singer_id, cell.judge_id);
            if (inp) {
              inp.value = cell.score || "";
              setVisual(inp, false);
            }
          });
        });
        updateProgress();
        setResolved(data.matrix_complete ? data.resolved_status : null);
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

  initCells(initial.grid);
  updateProgress();
  setVersion(state.version);
})();
