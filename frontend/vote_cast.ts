(() => {
  "use strict";

  const root = document.querySelector<HTMLElement>("[data-vote-cast]");
  if (!root) return;
  const form = root.querySelector<HTMLFormElement>("[data-vote-form]");
  const submit = root.querySelector<HTMLButtonElement>("[data-vote-submit]");
  const counter = root.querySelector<HTMLElement>("[data-selection-count]");
  const options = Array.from(root.querySelectorAll<HTMLInputElement>("[data-vote-option]"));
  const maxSelections = Number.parseInt(root.dataset.maxSelections || "1", 10);
  if (!form || !submit || !counter || options.length === 0 || !Number.isInteger(maxSelections) || maxSelections < 1) return;

  const update = (): void => {
    const selected = options.filter((option) => option.checked).length;
    counter.textContent = `已选择 ${selected} / ${maxSelections}`;
    submit.disabled = selected === 0;
  };

  options.forEach((option) => {
    option.addEventListener("change", () => {
      const over = options.filter((item) => item.checked).length > maxSelections;
      if (over) option.checked = false;
      update();
      // After `update()`, not before: the counter wrote over the warning on the next line,
      // so a voter who ticked one box too many only ever saw the running count and had to
      // work out why the box un-ticked itself.
      if (over) counter.textContent = `最多选择 ${maxSelections} 位选手`;
    });
  });

  form.addEventListener("submit", (event) => {
    if (!window.confirm(form.dataset.confirmMessage || "投票提交后不可修改，确定提交吗？")) {
      event.preventDefault();
    }
  });
  update();
})();
