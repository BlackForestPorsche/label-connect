/* global globalThis */
(function (root) {
  const api = root.AllDataRoLabels || (root.AllDataRoLabels = {});

  function showToast(message, kind) {
    const id = "alldata-ro-labels-toast";
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement("div");
      el.id = id;
      el.setAttribute("role", "status");
      Object.assign(el.style, {
        position: "fixed",
        zIndex: "2147483646",
        right: "16px",
        bottom: "16px",
        maxWidth: "320px",
        padding: "10px 14px",
        borderRadius: "8px",
        font: "600 13px/1.35 system-ui, sans-serif",
        color: "#f4f1ea",
        boxShadow: "0 8px 24px rgba(0,0,0,.35)",
        opacity: "0",
        transition: "opacity .18s ease",
        pointerEvents: "none",
      });
      document.documentElement.appendChild(el);
    }
    el.style.background = kind === "error" ? "#7a1f1f" : kind === "skip" ? "#4a4538" : "#1f4d2a";
    el.textContent = message;
    requestAnimationFrame(() => {
      el.style.opacity = "1";
    });
    clearTimeout(el._hide);
    el._hide = setTimeout(() => {
      el.style.opacity = "0";
    }, 4200);
  }

  api.showToast = showToast;
})(globalThis);
