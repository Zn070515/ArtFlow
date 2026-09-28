"use strict";
(() => {
    "use strict";
    const root = document.querySelector("[data-vote-cast]");
    if (!root)
        return;
    const form = root.querySelector("[data-vote-form]");
    const submit = root.querySelector("[data-vote-submit]");
    const counter = root.querySelector("[data-selection-count]");
    const options = Array.from(root.querySelectorAll("[data-vote-option]"));
    const maxSelections = Number.parseInt(root.dataset.maxSelections || "1", 10);
    if (!form || !submit || !counter || options.length === 0 || !Number.isInteger(maxSelections) || maxSelections < 1)
        return;
    const update = () => {
        const selected = options.filter((option) => option.checked).length;
        counter.textContent = `已选择 ${selected} / ${maxSelections}`;
        submit.disabled = selected === 0;
    };
    options.forEach((option) => {
        option.addEventListener("change", () => {
            if (options.filter((item) => item.checked).length > maxSelections) {
                option.checked = false;
                counter.textContent = `最多选择 ${maxSelections} 位选手`;
            }
            update();
        });
    });
    form.addEventListener("submit", (event) => {
        if (!window.confirm(form.dataset.confirmMessage || "投票提交后不可修改，确定提交吗？")) {
            event.preventDefault();
        }
    });
    update();
})();
