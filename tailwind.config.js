/** @type {import('tailwindcss').Config} */
// Class names are also written in Python (form widget attrs in accounts/forms.py and
// staff_panel/forms.py today), so the content list is directory-level per app — the
// same shape as pyrightconfig.json — rather than an `./**/*.py` sweep that would also
// walk .venv. A file-level list would silently miss every form module added later.
const appDirs = [
  "accounts",
  "archive",
  "common",
  "config",
  "core",
  "entry_access",
  "exports",
  "farewell_show",
  "files",
  "incidents",
  "public_portal",
  "questionnaire",
  "realtime",
  "ruleset",
  "singer_contest",
  "staff_panel",
  "tickets",
  "voting",
];

module.exports = {
  content: [
    "./templates/**/*.html",
    "./frontend/**/*.ts",
    ...appDirs.map((dir) => `./${dir}/**/*.py`),
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: "#1e3a5f",
          light: "#2d5a8e",
          dark: "#152a47"
        }
      }
    }
  },
  plugins: []
};
