// 比較用の旧形式UI。メニュー・画面遷移で目的の画面を開く。業務UIの描画は app.js の inuiMock.open を使う。
(() => {
  "use strict";

  const main = document.getElementById("legacy-main");
  const result = document.getElementById("result");
  const breadcrumb = document.getElementById("breadcrumb");

  const labels = {
    portal: "ポータル",
    week: "ポータル ＞ スケジュール",
    survey: "ポータル ＞ アンケート",
    settings: "ポータル ＞ 個人設定",
  };

  const go = (screen, date) => {
    result.innerHTML = "";
    if (screen === "survey") window.inuiMock.open({ kind: "survey" });
    if (screen === "settings") window.inuiMock.open({ kind: "settings" });
    if (screen === "day") window.inuiMock.open({ kind: "schedule", date });
    // 業務UIを開いたときは、ポータル・週間表示を隠して結果だけを見せる
    main.dataset.screen = ["survey", "settings", "day"].includes(screen) ? "result" : screen;
    breadcrumb.textContent = screen === "day"
      ? `ポータル ＞ スケジュール ＞ ${Number(date.slice(8))}日`
      : labels[screen];
    window.scrollTo(0, 0);
  };

  document.querySelectorAll("[data-nav]").forEach((b) =>
    b.addEventListener("click", () => go(b.dataset.nav)));
  document.querySelectorAll("[data-day]").forEach((b) =>
    b.addEventListener("click", () => go("day", b.dataset.day)));
})();
