/* Admin-only account panel. All authorization is rechecked by the server. */
window.createDealsInvites = function (changed) {
  "use strict";
  const $ = (id) => document.getElementById(id);
  let client,
    owner = null,
    allowed = false,
    opened = false,
    generation = 0;
  let busy = false,
    people = [],
    confirmation = null,
    success = null;
  const text = (id, value) => {
    $(id).textContent = value;
  };
  const button = (label, action, danger = false) => {
    const element = document.createElement("button");
    element.type = "button";
    element.className = danger ? "text-button danger-text" : "text-button";
    element.textContent = label;
    element.disabled = busy;
    element.onclick = action;
    return element;
  };
  function render() {
    $("invites-panel").hidden = !allowed || !opened;
    $("invite-submit").disabled = busy;
    $("invite-email").disabled = busy;
    $("invite-note").disabled = busy;
    const list = $("invite-people");
    list.replaceChildren();
    for (const person of people.filter(
      (person) => person.status !== "removed",
    )) {
      const item = document.createElement("li");
      item.className = "invite-person";
      const name = document.createElement("strong");
      name.textContent = person.note || person.email;
      const detail = document.createElement("p");
      detail.className = "quiet";
      detail.textContent =
        (person.note ? person.email + " · " : "") +
        (person.status === "joined"
          ? "Joined" +
            (person.joined_at
              ? " · " + new Date(person.joined_at).toLocaleDateString()
              : "")
          : "Invited");
      item.append(name, detail);
      if (confirmation === person.email) {
        const warning = document.createElement("p");
        warning.tabIndex = -1;
        warning.id = "invite-remove-title";
        warning.textContent =
          "Remove access for " +
          (person.note || person.email) +
          "? This deletes their account, uses, notes and settings.";
        item.append(
          warning,
          button(
            "Remove permanently",
            () => void act("remove", person.email),
            true,
          ),
          button("Cancel", () => {
            confirmation = null;
            render();
            document.getElementById("remove-" + person.email)?.focus();
          }),
        );
      } else {
        const remove = button(
          "Remove access",
          () => {
            confirmation = person.email;
            render();
            $("invite-remove-title").focus();
          },
          true,
        );
        remove.id = "remove-" + person.email;
        remove.setAttribute(
          "aria-label",
          "Remove access for " + (person.note || person.email),
        );
        item.append(remove);
      }
      list.append(item);
    }
    $("invite-empty").hidden = list.children.length > 0;
    $("invite-success").hidden = !success;
    text(
      "invite-success-text",
      success ? success.name + " can now sign in" : "",
    );
    text("invite-share", navigator.share ? "Share" : "Copy message");
  }
  async function list() {
    const revision = generation;
    text("invite-list-status", "Loading people…");
    $("invite-empty").hidden = true;
    $("invite-retry").hidden = true;
    try {
      const result = await client.rpc("admin_invites");
      if (result.error) throw result.error;
      if (revision !== generation) return;
      people = result.data;
      text("invite-list-status", "");
      render();
    } catch {
      if (revision !== generation) return;
      text("invite-list-status", "Could not load people. Try again.");
      $("invite-retry").hidden = false;
    }
  }
  async function act(action, email) {
    if (busy || !allowed) return;
    const revision = generation;
    busy = true;
    text("invite-error", "");
    render();
    try {
      const note = $("invite-note").value.trim();
      const result = await client.functions.invoke("admin-invite", {
        body: { action, email, note },
      });
      if (result.error) {
        let message = "Could not finish. Please try again.";
        try {
          message = (await result.error.context.json()).error || message;
        } catch {
          /* Safe fallback. */
        }
        throw new Error(message);
      }
      if (revision !== generation) return;
      if (action === "invite") {
        success = { email, name: note || email };
        $("invite-email").value = "";
        $("invite-note").value = "";
      } else {
        confirmation = null;
        if (success?.email === email) success = null;
      }
      text("invite-share-status", "");
      await list();
    } catch (error) {
      if (revision === generation) text("invite-error", error.message);
    } finally {
      if (revision === generation) {
        busy = false;
        render();
      }
    }
  }
  $("invites-open").onclick = () => {
    if (!allowed) return;
    opened = true;
    render();
    changed();
    $("invite-title").focus();
    void list();
  };
  $("invites-back").onclick = () => {
    opened = false;
    changed();
    render();
    $("invites-open").focus();
  };
  $("invite-form").onsubmit = (event) => {
    event.preventDefault();
    void act("invite", $("invite-email").value.trim().toLowerCase());
  };
  $("invite-retry").onclick = () => void list();
  $("invite-share").onclick = async () => {
    if (!success) return;
    const message =
      "Join me on Deals: https://danieltsao0103.github.io/starving-student-deals/ — sign in with " +
      success.email +
      ".";
    try {
      if (navigator.share) await navigator.share({ text: message });
      else {
        await navigator.clipboard.writeText(message);
        text("invite-share-status", "Copied");
      }
    } catch (error) {
      if (error.name !== "AbortError")
        text("invite-error", "Could not share. Please try again.");
    }
  };
  return {
    isOpen: () => allowed && opened,
    visibility(focused) {
      $("invites-open").hidden = !allowed || focused;
    },
    async session(nextClient, user) {
      if (owner === (user?.id || null)) return;
      client = nextClient;
      owner = user?.id || null;
      const revision = ++generation;
      allowed = false;
      opened = false;
      people = [];
      confirmation = null;
      success = null;
      busy = false;
      $("invite-email").value = "";
      $("invite-note").value = "";
      text("invite-error", "");
      text("invite-list-status", "");
      text("invite-share-status", "");
      render();
      changed();
      if (!owner) return;
      try {
        const result = await client.rpc("is_admin");
        if (revision !== generation) return;
        allowed = !result.error && result.data === true;
        changed();
      } catch {
        /* Fail closed, without interrupting normal account use. */
      }
    },
  };
};
