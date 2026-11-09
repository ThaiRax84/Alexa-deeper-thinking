// Portal front end: Cognito sign-in (authorization code + PKCE) and settings forms.
const $ = (s) => document.querySelector(s);
const REDIRECT = `${location.origin}/`;
const KEY_HELP = {
  anthropic: ["console.anthropic.com", "https://console.anthropic.com/settings/keys"],
  openai: ["platform.openai.com", "https://platform.openai.com/api-keys"],
  google: ["aistudio.google.com", "https://aistudio.google.com/apikey"],
};
const ZONES = [
  ["America/Mexico_City", "Centro (Ciudad de México)"],
  ["America/Cancun", "Sureste (Quintana Roo)"],
  ["America/Mazatlan", "Pacífico (Sinaloa, Nayarit, BCS)"],
  ["America/Hermosillo", "Sonora"],
  ["America/Tijuana", "Noroeste (Baja California)"],
];

let cfg;

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

function token() {
  const t = JSON.parse(sessionStorage.getItem("token") || "null");
  return t && t.expires > Date.now() ? t.value : null;
}

async function login() {
  const verifier = random(48);
  const state = random(16);
  sessionStorage.setItem("pkce", JSON.stringify({ verifier, state }));
  const q = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: REDIRECT,
    scope: "openid email",
    state,
    code_challenge: b64url(await sha256(verifier)),
    code_challenge_method: "S256",
    lang: "es",
  });
  location.assign(`https://${cfg.cognitoDomain}/oauth2/authorize?${q}`);
}

async function finishLogin() {
  const p = new URLSearchParams(location.search);
  const code = p.get("code");
  if (!code) return;
  const saved = JSON.parse(sessionStorage.getItem("pkce") || "null");
  sessionStorage.removeItem("pkce");
  history.replaceState({}, "", "/");
  if (!saved || saved.state !== p.get("state")) return;
  const res = await fetch(`https://${cfg.cognitoDomain}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: cfg.clientId,
      code,
      redirect_uri: REDIRECT,
      code_verifier: saved.verifier,
    }),
  });
  if (!res.ok) return;
  const t = await res.json();
  sessionStorage.setItem("token", JSON.stringify({ value: t.access_token, expires: Date.now() + (t.expires_in - 60) * 1000 }));
}

function logout() {
  sessionStorage.clear();
  const q = new URLSearchParams({ client_id: cfg.clientId, logout_uri: REDIRECT });
  location.assign(`https://${cfg.cognitoDomain}/logout?${q}`);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${token()}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    sessionStorage.removeItem("token");
    show();
  }
  if (!res.ok) throw new Error(data.error || "Algo salió mal. Intenta de nuevo.");
  return data;
}

function status(id, text, ok = true) {
  const el = $(id);
  el.textContent = text;
  el.className = `status ${ok ? "ok" : "error"}`;
}

async function busy(form, fn) {
  const btn = form.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    await fn();
  } finally {
    btn.disabled = false;
  }
}

function keyHelp() {
  const [label, url] = KEY_HELP[$("#provider").value] ?? [];
  const help = $("#key-help");
  help.textContent = "";
  if (!url) return;
  const a = Object.assign(document.createElement("a"), { href: url, target: "_blank", rel: "noopener", textContent: label });
  help.append("Consigue tu llave en ", a, ". El uso se cobra en tu cuenta con esa empresa.");
}

function render(me) {
  $("#provider").replaceChildren(...cfg.providers.map((p) => new Option(p.label, p.id)));
  if (me.ai) {
    $("#provider").value = me.ai.provider;
    status("#ai-status", `Conectado con ${me.ai.label}. Modelos: ${me.ai.models?.fast ?? "?"} (rápido) y ${me.ai.models?.deep ?? "?"} (a fondo).`);
    $("#api-key").placeholder = "Guardada. Pega otra para cambiarla.";
  }
  keyHelp();

  $("#cal-remove").hidden = !me.calendar;
  if (me.calendar) {
    $("#cal-user").value = me.calendar.username;
    status("#cal-status", `Calendario conectado: ${me.calendar.username}.`);
  }

  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zones = ZONES.some(([z]) => z === browserZone) ? ZONES : [...ZONES, [browserZone, browserZone]];
  $("#timezone").replaceChildren(...zones.map(([z, label]) => new Option(label, z)));
  $("#timezone").value = me.timezone || (zones.some(([z]) => z === browserZone) ? browserZone : "America/Mexico_City");
  const radio = document.querySelector(`input[name=channel][value="${me.preferredChannel ?? "voz"}"]`);
  if (radio) radio.checked = true;
  $("#email").value = me.contact?.email ?? "";
  $("#phone").value = me.contact?.phone ?? "";
}

async function show() {
  const signedIn = Boolean(token());
  $("#login").hidden = signedIn;
  $("#setup").hidden = !signedIn;
  if (signedIn) render(await api("GET", "/api/me"));
}

function bind() {
  $("#login-btn").addEventListener("click", login);
  $("#logout").addEventListener("click", logout);
  $("#provider").addEventListener("change", keyHelp);

  $("#ai-form").addEventListener("submit", (e) => {
    e.preventDefault();
    busy(e.target, async () => {
      status("#ai-status", "Verificando tu llave…");
      try {
        const r = await api("PUT", "/api/ai", { provider: $("#provider").value, apiKey: $("#api-key").value });
        $("#api-key").value = "";
        status("#ai-status", `Listo: ${r.label} conectado. Modelos: ${r.models.fast} (rápido) y ${r.models.deep} (a fondo).`);
      } catch (err) {
        status("#ai-status", err.message, false);
      }
    });
  });

  $("#cal-form").addEventListener("submit", (e) => {
    e.preventDefault();
    busy(e.target, async () => {
      status("#cal-status", "Conectando con iCloud…");
      try {
        const r = await api("PUT", "/api/calendar", { username: $("#cal-user").value, appPassword: $("#cal-pass").value });
        $("#cal-pass").value = "";
        $("#cal-remove").hidden = false;
        status("#cal-status", `Listo: encontré ${r.calendars} calendario(s).`);
      } catch (err) {
        status("#cal-status", err.message, false);
      }
    });
  });

  $("#cal-remove").addEventListener("click", async () => {
    try {
      await api("DELETE", "/api/calendar");
      $("#cal-remove").hidden = true;
      status("#cal-status", "Calendario desconectado.");
    } catch (err) {
      status("#cal-status", err.message, false);
    }
  });

  $("#prefs-form").addEventListener("submit", (e) => {
    e.preventDefault();
    busy(e.target, async () => {
      try {
        await api("PUT", "/api/preferences", {
          preferredChannel: document.querySelector("input[name=channel]:checked")?.value,
          email: $("#email").value,
          phone: $("#phone").value,
          timezone: $("#timezone").value,
        });
        status("#prefs-status", "Guardado.");
      } catch (err) {
        status("#prefs-status", err.message, false);
      }
    });
  });

  $("#delete").addEventListener("click", async () => {
    if (!confirm("Se borrarán tu configuración, llaves e historial de investigaciones. ¿Continuar?")) return;
    try {
      await api("DELETE", "/api/me");
      status("#account-status", "Tus datos fueron eliminados. Para desactivar la skill, quítala desde la app de Alexa.");
    } catch (err) {
      status("#account-status", err.message, false);
    }
  });
}

cfg = await (await fetch("/api/config")).json();
bind();
await finishLogin();
await show();
