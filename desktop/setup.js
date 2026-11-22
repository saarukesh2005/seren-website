// First-time setup and "try again" for the SEREN Counter app.
(function () {
  "use strict";
  const f = document.getElementById("f");
  if (f) {
    const url = document.getElementById("url");
    window.serenSetup.getServer().then((s) => { if (s) url.value = s; });
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const go = document.getElementById("go");
      go.disabled = true; go.textContent = "Connecting…";
      document.getElementById("err").textContent = "";
      try { await window.serenSetup.setServer(url.value); }
      catch (ex) {
        document.getElementById("err").textContent = String(ex.message || ex).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
        go.disabled = false; go.textContent = "Connect";
      }
    });
  }
  const retry = document.getElementById("retry");
  if (retry) retry.addEventListener("click", () => window.serenSetup.retry());
})();
