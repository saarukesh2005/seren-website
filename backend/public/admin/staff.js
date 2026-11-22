/* Settings (owner only): staff logins, "log out everyone", the activity log, and backups. */
SA.staff = (function () {
  "use strict";
  const { esc, api, toast, ago } = SA;
  const $ = (s) => document.querySelector(s);
  const ROLES = { manager: "Manager: everything except settings and staff", cashier: "Cashier: orders, bills, tables, kitchen", kitchen: "Kitchen: the kitchen screen only" };
  let wired = false;

  async function render() {
    if (!SA.can("owner")) return;
    const box = $("#staffBox");
    try {
      const [{ staff }, { log }] = await Promise.all([api("/staff"), api("/activity")]);
      box.innerHTML = `
        <fieldset><legend>Staff logins</legend>
          <p class="full help">Each person logs in with their own name and password, so the activity log shows who did what. You log in with your name left empty.</p>
          <div class="full table-wrap"><table class="grid"><thead><tr><th>Name</th><th>Role</th><th>On</th><th>New password</th></tr></thead><tbody>
            ${staff.length ? staff.map((p) => `<tr data-staff="${p.id}"><td><b>${esc(p.name)}</b></td>
              <td><select data-role aria-label="${esc(p.name)} role">${Object.keys(ROLES).map((r) => `<option value="${r}" ${r === p.role ? "selected" : ""}>${r[0].toUpperCase()}${r.slice(1)}</option>`).join("")}</select></td>
              <td><input type="checkbox" data-active ${p.active ? "checked" : ""} aria-label="${esc(p.name)} can log in"></td>
              <td><span class="inline"><input data-pw type="password" autocomplete="new-password" placeholder="8+ characters" aria-label="New password for ${esc(p.name)}"><button class="btn ghost small" type="button" data-setpw>Set</button></span></td></tr>`).join("")
            : `<tr><td colspan="4" class="empty">No staff yet</td></tr>`}</tbody></table></div>
          <form class="full formgrid" id="addStaff">
            <label>Name<input name="name" maxlength="30" required autocomplete="off"></label>
            <label>Role<select name="role">${Object.entries(ROLES).map(([r, l]) => `<option value="${r}">${esc(l)}</option>`).join("")}</select></label>
            <label>Password<input name="password" type="password" autocomplete="new-password" required minlength="8"></label>
            <div><button class="btn primary" type="submit">Add staff</button></div>
          </form>
          <div class="full"><button class="btn ghost small" type="button" id="logoutAll">Log out everyone (all phones)</button> <span class="help">Use this if a phone is lost. Everyone, you too, logs in again.</span></div>
        </fieldset>
        <fieldset><legend>Backups</legend>
          <p class="full help">Everything (orders, bills, customers, settings) in one file. Keep a copy somewhere safe.
            Nightly backups go to your Telegram automatically once Telegram alerts are set up.</p>
          <div class="full"><a class="btn ghost" href="/api/admin/backup.json">Download a backup now</a></div>
        </fieldset>
        <fieldset><legend>Activity log</legend>
          <ul class="full log activity">${log.map((l) => `<li><span class="meta">${esc(ago(l.at))}</span> <b>${esc(l.actor)}</b> ${esc(l.action)}${l.detail ? ` <span class="opt">· ${esc(l.detail)}</span>` : ""}</li>`).join("") || "<li>Nothing yet</li>"}</ul>
        </fieldset>`;
      wire();
    } catch (e) { toast(e.message, true); }
  }

  function wire() {
    if (wired) return;
    wired = true;
    const box = $("#staffBox");
    box.addEventListener("change", async (e) => {
      const row = e.target.closest("[data-staff]");
      if (!row) return;
      const body = e.target.matches("[data-role]") ? { role: e.target.value } : e.target.matches("[data-active]") ? { active: e.target.checked } : null;
      if (!body) return;
      try { await api(`/staff/${row.dataset.staff}`, body); toast("Saved. They'll need to log in again."); }
      catch (ex) { toast(ex.message, true); render(); }
    });
    box.addEventListener("click", async (e) => {
      if (e.target.closest("[data-setpw]")) {
        const row = e.target.closest("[data-staff]");
        const pw = row.querySelector("[data-pw]").value;
        try { await api(`/staff/${row.dataset.staff}`, { password: pw }); toast("Password changed"); row.querySelector("[data-pw]").value = ""; }
        catch (ex) { toast(ex.message, true); }
      }
      if (e.target.id === "logoutAll" && window.confirm("Log everyone out on every phone and computer?")) {
        try { await api("/logout-everyone", {}); location.reload(); } catch (ex) { toast(ex.message, true); }
      }
    });
    box.addEventListener("submit", async (e) => {
      if (e.target.id !== "addStaff") return;
      e.preventDefault();
      const f = e.target;
      const v = (n) => f.elements.namedItem(n).value;
      try { await api("/staff", { name: v("name").trim(), role: v("role"), password: v("password") }); toast(`${v("name")} can now log in`); render(); }
      catch (ex) { toast(ex.message, true); }
    });
  }
  return { render };
})();
