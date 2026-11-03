import { assignRef, ensureAttached, getRef, pageInfo, send } from "./cdp.js";
import { clamp, cleanText } from "./util.js";

const MAX_AX_NODES = 20000;
const MAX_RENDER_NODES = 15000;
const MAX_JSON_NODES = 3000;
const MAX_DEPTH = 40;

const SKIP_ROLES = new Set(["InlineTextBox", "LineBreak"]);
const TEXT_ROLES = new Set(["StaticText"]);
const CONTAINER_ROLES = new Set(["generic", "none", "presentation", "RootWebArea"]);
const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider"]);
const NAME_FROM_TEXT_ROLES = new Set([
  "button",
  "link",
  "heading",
  "menuitem",
  "option",
  "tab",
  "treeitem",
]);

const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);

export async function capture(tabId, args = {}, tab = null) {
  await ensureAttached(tabId);
  const format = args.format === "aria" ? "aria" : "json";
  const maxChars = clamp(args.max_chars ?? 60000, 1, 60000);
  const interactiveOnly = args.interactive === true;

  const response = await send(tabId, "Accessibility.getFullAXTree", {}, { timeoutMs: 60000 });
  let nodes = response?.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error("snapshot: the page returned an empty accessibility tree");
  }
  const nodeLimitHit = nodes.length > MAX_AX_NODES;
  if (nodeLimitHit) nodes = nodes.slice(0, MAX_AX_NODES);

  const byId = new Map();
  for (const node of nodes) byId.set(node.nodeId, node);
  const childrenOf = (node) => (node.childIds ?? []).map((id) => byId.get(id)).filter(Boolean);

  let root = null;
  if (args.ref !== undefined) {
    const ref = String(args.ref).replace(/^@/, "");
    const info = getRef(tabId, ref);
    if (!info) throw new Error(`snapshot: unknown ref "${ref}". Run snapshot without ref first.`);
    root = nodes.find((node) => node.backendDOMNodeId === info.backendNodeId) ?? null;
    if (!root) throw new Error(`snapshot: ref "${ref}" no longer exists on the page. Run snapshot again.`);
  } else {
    root = nodes.find((node) => !node.parentId && !node.ignored) ?? nodes.find((node) => !node.parentId) ?? nodes[0];
  }

  const budget = { nodes: 0 };
  const info = await pageInfo(tabId).catch(() => ({}));
  const url = info.url || tab?.url || "";
  const title = info.title || tab?.title || "";

  if (format === "aria") {
    const renderer = { lines: [], length: 0, truncated: false, nodeBudget: 0 };
    walk(root, 0, renderer, { tabId, childrenOf, interactiveOnly, maxChars }, "");
    const truncated = renderer.truncated;
    return {
      url,
      title,
      tree_text: renderer.lines.join("\n"),
      ref_policy: "stable-node",
      ...(truncated || nodeLimitHit ? { truncated: true } : {}),
    };
  }

  const tree = jsonNodes(root, 0, budget, { tabId, childrenOf, interactiveOnly });
  return {
    url,
    title,
    tree,
    ref_policy: "stable-node",
    ...(budget.nodes >= MAX_JSON_NODES || nodeLimitHit ? { truncated: true } : {}),
  };
}

function describe(node, tabId, interactiveOnly) {
  const role = node.role?.value ?? "generic";
  const name = cleanText(node.name?.value, 180);
  const value = cleanText(node.value?.value, 120);
  const interactive = INTERACTIVE_ROLES.has(role);
  if (interactiveOnly && !interactive) {
    return { role, name, value, ref: null, interactive, text: TEXT_ROLES.has(role), valueRelevant: VALUE_ROLES.has(role) };
  }
  let ref = null;
  if (Number.isInteger(node.backendDOMNodeId) && (interactive || name)) {
    ref = assignRef(tabId, node.backendDOMNodeId);
  }
  return {
    role,
    name,
    value,
    ref,
    interactive,
    text: TEXT_ROLES.has(role),
    valueRelevant: VALUE_ROLES.has(role),
  };
}

function walk(node, depth, renderer, context, hideTextForName = "") {
  if (!node || renderer.truncated) return;
  renderer.nodeBudget += 1;
  if (renderer.nodeBudget > MAX_RENDER_NODES) {
    renderer.truncated = true;
    return;
  }
  if (depth > MAX_DEPTH) return;

  if (node.ignored) {
    for (const child of context.childrenOf(node)) walk(child, depth, renderer, context, hideTextForName);
    return;
  }

  const role = node.role?.value ?? "generic";
  if (SKIP_ROLES.has(role)) return;
  const described = describe(node, context.tabId, context.interactiveOnly);
  const { name, value, ref } = described;
  const isText = described.text;
  let printed = false;

  if (isText) {
    if (!context.interactiveOnly && name && name !== hideTextForName) {
      printed = push(renderer, `- text: ${name}`, depth, context.maxChars);
    }
    return; // InlineTextBox children duplicate the same text.
  }

  if (context.interactiveOnly) {
    if (ref) {
      printed = push(
        renderer,
        `- ${role}${name ? ` "${name}"` : ""}${value && described.valueRelevant ? ` value="${value}"` : ""} [ref=${ref}]`,
        depth,
        context.maxChars,
      );
    }
  } else if (CONTAINER_ROLES.has(role)) {
    // Containers are only interesting when they carry an accessible name.
    if (name && role !== "RootWebArea") {
      printed = push(renderer, `- ${role} "${name}"${ref ? ` [ref=${ref}]` : ""}`, depth, context.maxChars);
    }
  } else if (name || ref || described.valueRelevant || role === "heading" || role === "img") {
    const suffix = value && described.valueRelevant ? ` value="${value}"` : "";
    const label = name ? ` "${name}"` : "";
    printed = push(renderer, `- ${role}${label}${suffix}${ref ? ` [ref=${ref}]` : ""}`, depth, context.maxChars);
  }

  const childDepth = printed ? depth + 1 : depth;
  const childHide = printed && NAME_FROM_TEXT_ROLES.has(role) ? name : "";
  for (const child of context.childrenOf(node)) {
    walk(child, childDepth, renderer, context, childHide);
  }
}

function push(renderer, line, depth, maxChars) {
  if (renderer.truncated) return false;
  const text = `${"  ".repeat(Math.min(depth, MAX_DEPTH))}${line}`;
  if (renderer.length + text.length + 1 > maxChars) {
    renderer.truncated = true;
    return false;
  }
  renderer.lines.push(text);
  renderer.length += text.length + 1;
  return true;
}

function jsonNodes(node, depth, budget, context) {
  if (!node || depth > MAX_DEPTH || budget.nodes >= MAX_JSON_NODES) return [];
  if (node.ignored) {
    return context.childrenOf(node).flatMap((child) => jsonNodes(child, depth, budget, context));
  }
  const role = node.role?.value ?? "generic";
  if (SKIP_ROLES.has(role)) return [];
  const described = describe(node, context.tabId, context.interactiveOnly);
  const isText = described.text;
  const hasRef = Boolean(described.ref);
  if (context.interactiveOnly && !hasRef) {
    return context.childrenOf(node).flatMap((child) => jsonNodes(child, depth, budget, context));
  }
  if (role === "RootWebArea") {
    return context.childrenOf(node).flatMap((child) => jsonNodes(child, depth, budget, context));
  }
  budget.nodes += 1;
  const entry = { role: isText ? "text" : role };
  if (described.name) entry.name = described.name;
  if (described.value && described.valueRelevant) entry.value = described.value;
  if (described.ref) entry.ref = `@${described.ref}`;
  const children = context.childrenOf(node).flatMap((child) => jsonNodes(child, depth + 1, budget, context));
  if (children.length > 0) entry.children = children;
  return [entry];
}
