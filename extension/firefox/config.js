/* global globalThis */
(function (root) {
  const cfg = root.AllDataRoLabels || (root.AllDataRoLabels = {});
  cfg.DEFAULT_LABELS_BASE = "http://127.0.0.1:8080";
  cfg.DEFAULT_SHOP_BASE = "https://shop.blackforestautomotive.com";
  cfg.DEFAULT_TOOLS_BRIDGE_BASE = "http://127.0.0.1:8788";
  cfg.SHOP_GATE_COOKIE = "bf_shop_gate";
  cfg.CREATE_LABEL_RE = /^\s*create\s*r\s*\/?\s*o\s*$/i;
  cfg.UPDATE_LABEL_RE = /^\s*update\s*r\s*\/?\s*o\s*$/i;
  cfg.ASSIGN_LABEL_RE = /^\s*assign\s*r\s*\/?\s*o\s*$/i;
  cfg.SCHEDULE_NEW_RE = /^\s*(new\s*r\s*\/?\s*o|schedule\s*new)\s*$/i;
  cfg.SUCCESS_WAIT_MS = 12000;
})(globalThis);
