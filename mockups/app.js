// デザイン確認用のモック。Intent判定・業務API・保存はすべてブラウザ内のダミーで、本実装の設計を表すものではない。
(() => {
  "use strict";

  const result = document.getElementById("result");
  const form = document.getElementById("intent-form");
  const input = document.getElementById("intent-input");
  const submit = document.getElementById("intent-submit");

  // ダミーの業務データ（MVP.mdの検証用データ）
  const state = {
    surveyAnswer: null,
    theme: "light",
  };
  const schedules = {
    "2026-11-02": [{ start: "10:00", end: "10:30", subject: "定例会議" }],
    "2026-11-03": [
      { start: "10:00", end: "10:30", subject: "朝会" },
      { start: "14:00", end: "15:00", subject: "MVP検証打ち合わせ" },
    ],
    "2026-11-04": [],
  };
  const surveyOptions = ["使いやすい", "どちらともいえない", "使いにくい"];

  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const formatDate = (iso) => {
    const [y, m, day] = iso.split("-").map(Number);
    const w = "日月火水木金土"[new Date(Date.UTC(y, m - 1, day)).getUTCDay()];
    return `${y}年${m}月${day}日（${w}）`;
  };

  // ダミーのIntent判定（キーワード照合）
  const classify = (text) => {
    const t = text.replace(/\s/g, "");
    if (/削除|消して|登録|編集/.test(t)) return { kind: "unsupported-op" };
    if (/文書|ファイル|資料/.test(t)) return { kind: "unsupported-feature" };
    if (/アンケート/.test(t)) return { kind: "survey" };
    if (/設定|テーマ|見た目/.test(t)) return { kind: "settings" };
    if (/予定|スケジュール/.test(t)) {
      if (/今日/.test(t)) return { kind: "schedule", date: "2026-11-02" };
      if (/明日/.test(t)) return { kind: "schedule", date: "2026-11-03" };
      const m = t.match(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日/);
      if (m) {
        const iso = `${m[1] || "2026"}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
        return { kind: "schedule", date: iso };
      }
      return { kind: "need-date" };
    }
    return { kind: "unclear" };
  };

  const echo = (text) =>
    text ? `<p class="request-echo">入力：<q>${escapeHtml(text)}</q></p>` : "";

  const notice = (type, icon, title, text, actions = "") => `
    <div class="notice notice-${type}" role="${type === "error" ? "alert" : "status"}">
      <span class="notice-icon" aria-hidden="true">${icon}</span>
      <div>
        <p class="notice-title">${title}</p>
        <p class="notice-text">${text}</p>
        ${actions ? `<div class="notice-actions">${actions}</div>` : ""}
      </div>
    </div>`;

  // --- 事前実装済みUI ---
  const renderSurvey = (text) => {
    result.innerHTML = `${echo(text)}
      <form class="card" id="survey-form" novalidate>
        <div class="card-header">
          <h2 class="card-title">inui利用体験アンケート</h2>
          <span class="card-sub">回答フォーム</span>
        </div>
        <div class="card-body">
          <fieldset>
            <legend>この画面は使いやすいですか<span class="required">必須</span></legend>
            <div class="options">
              ${surveyOptions.map((o) => `
                <label class="option">
                  <input type="radio" name="answer" value="${o}" ${state.surveyAnswer === o ? "checked" : ""}>
                  <span>${o}</span>
                </label>`).join("")}
            </div>
            <p class="field-error" id="survey-error" hidden>回答を選択してください。</p>
          </fieldset>
        </div>
        <div class="card-footer">
          ${state.surveyAnswer ? `<span class="saved-note">回答済み：${state.surveyAnswer}</span>` : ""}
          <button type="submit" class="btn btn-primary">回答を保存</button>
        </div>
      </form>`;
    document.getElementById("survey-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const checked = e.target.querySelector("input[name=answer]:checked");
      const err = document.getElementById("survey-error");
      if (!checked) { err.hidden = false; return; }
      state.surveyAnswer = checked.value;
      toast("回答を保存しました");
      renderSurvey(text);
    });
  };

  const renderSchedule = (text, date) => {
    const items = schedules[date] || [];
    const body = items.length
      ? `<ul class="schedule">${items.map((i) => `
          <li><time>${i.start}–${i.end}</time><span class="subject">${escapeHtml(i.subject)}</span></li>`).join("")}</ul>`
      : `<div class="empty-state">この日の予定はありません。</div>`;
    result.innerHTML = `${echo(text)}
      <section class="card">
        <div class="card-header">
          <h2 class="card-title">${formatDate(date)}の予定</h2>
          <span class="card-sub">${items.length}件</span>
        </div>
        ${body}
      </section>`;
  };

  const renderSettings = (text) => {
    result.innerHTML = `${echo(text)}
      <form class="card" id="settings-form">
        <div class="card-header">
          <h2 class="card-title">表示設定</h2>
          <span class="card-sub">現在のテーマ：${state.theme === "dark" ? "ダーク" : "ライト"}</span>
        </div>
        <div class="card-body">
          <fieldset>
            <legend>表示テーマ</legend>
            <div class="options options-row">
              ${[["light", "ライト"], ["dark", "ダーク"]].map(([v, l]) => `
                <label class="option">
                  <input type="radio" name="theme" value="${v}" ${state.theme === v ? "checked" : ""}>
                  <span>${l}</span>
                </label>`).join("")}
            </div>
          </fieldset>
        </div>
        <div class="card-footer">
          <button type="submit" class="btn btn-primary">設定を保存</button>
        </div>
      </form>`;
    document.getElementById("settings-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const v = e.target.querySelector("input[name=theme]:checked").value;
      state.theme = v;
      document.documentElement.dataset.theme = v;
      toast("表示設定を保存しました");
      renderSettings(text);
    });
  };

  // --- 案内・失敗 ---
  const renderNotice = (text, kind) => {
    const map = {
      "unsupported-feature": ["info", "i", "この機能には対応していません",
        "現在利用できるのは、アンケート回答・予定の確認・表示設定の変更です。"],
      "unsupported-op": ["info", "i", "この操作には対応していません",
        "予定は確認のみできます。登録・編集・削除はできません。"],
      unclear: ["warn", "?", "やりたいことを特定できませんでした",
        "対象を含めて、もう一度入力してください。（例：アンケートを開いて）"],
      "need-date": ["warn", "?", "日付を指定してください",
        "どの日の予定を確認しますか？（例：明日の予定を見せて、11月4日の予定）"],
      rejected: ["error", "!", "この要求は処理できませんでした",
        "判定結果が許可された範囲外だったため、処理を中止しました。業務データは変更されていません。"],
    };
    const [type, icon, title, body] = map[kind];
    result.innerHTML = echo(text) + notice(type, icon, title, body);
  };

  const renderNetworkError = (text) => {
    result.innerHTML = echo(text) + notice("error", "!", "通信に失敗しました",
      "時間をおいて再試行してください。入力内容は保持されています。",
      `<button type="button" class="btn" id="retry">再試行</button>`);
    document.getElementById("retry").addEventListener("click", () => run(text || "明日の予定を見せて"));
  };

  const renderLoading = (text) => {
    result.innerHTML = `${echo(text)}
      <div class="loading"><span class="spinner" aria-hidden="true"></span>画面を準備しています…</div>
      <div class="card skeleton" aria-hidden="true"><span></span><span></span><span></span></div>`;
  };

  let toastTimer;
  const toast = (msg) => {
    document.querySelector(".toast")?.remove();
    const el = document.createElement("div");
    el.className = "toast";
    el.setAttribute("role", "status");
    el.textContent = msg;
    document.body.append(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), 2400);
  };

  const show = (text, intent) => {
    switch (intent.kind) {
      case "survey": return renderSurvey(text);
      case "schedule": return renderSchedule(text, intent.date);
      case "settings": return renderSettings(text);
      default: return renderNotice(text, intent.kind);
    }
  };

  const run = (text) => {
    input.value = text;
    submit.disabled = true;
    renderLoading(text);
    setTimeout(() => {
      submit.disabled = false;
      show(text, classify(text));
    }, 600);
  };

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (text) run(text);
  });

  // ヘルプサイドバー。初回は開いた状態で表示し、閉じたことは閲覧者のブラウザに記憶する。
  const helpPanel = document.getElementById("help-panel");
  const helpToggle = document.getElementById("help-toggle");
  const HELP_KEY = "inui-mock-help-dismissed";
  const narrow = () => window.matchMedia("(max-width: 1099px)").matches;
  const setHelp = (open) => {
    helpPanel.hidden = !open;
    helpToggle.setAttribute("aria-expanded", String(open));
    document.body.classList.toggle("help-open", open);
    if (!open) {
      try { localStorage.setItem(HELP_KEY, "1"); } catch { /* 保存できなくても動作は継続 */ }
    }
  };
  helpToggle.addEventListener("click", () => setHelp(helpPanel.hidden));
  document.getElementById("help-close").addEventListener("click", () => { setHelp(false); helpToggle.focus(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !helpPanel.hidden) { setHelp(false); helpToggle.focus(); }
  });
  let dismissed = false;
  try { dismissed = localStorage.getItem(HELP_KEY) === "1"; } catch { /* 読めなければ初回扱い */ }
  if (!dismissed) setHelp(true);

  document.querySelectorAll("[data-example]").forEach((b) =>
    b.addEventListener("click", () => {
      // 狭い画面ではサイドバーが結果を覆うため、例を試したら閉じる
      if (narrow() && b.closest("#help-panel")) setHelp(false);
      run(b.dataset.example);
    }));

  // モック専用パネル
  document.querySelectorAll("[data-mock]").forEach((b) =>
    b.addEventListener("click", () => { input.value = b.dataset.mock; show(b.dataset.mock, classify(b.dataset.mock)); }));
  document.querySelectorAll("[data-mock-state]").forEach((b) =>
    b.addEventListener("click", () => {
      const s = b.dataset.mockState;
      const text = input.value.trim();
      if (s === "rejected") renderNotice(text || "明日の予定を見せて", "rejected");
      else if (s === "network") renderNetworkError(text || "明日の予定を見せて");
      else if (s === "loading") renderLoading(text || "明日の予定を見せて");
      else { input.value = ""; result.innerHTML = ""; }
    }));
})();
