function hideAgentDocsIndex() {
  document.querySelectorAll('[data-agent-docs-index="true"]').forEach((element) => {
    element.setAttribute("aria-hidden", "true");
    element.setAttribute("hidden", "");
    element.style.display = "none";
  });
}

hideAgentDocsIndex();

document.addEventListener("DOMContentLoaded", hideAgentDocsIndex);

new MutationObserver(hideAgentDocsIndex).observe(document.documentElement, {
  childList: true,
  subtree: true,
});
