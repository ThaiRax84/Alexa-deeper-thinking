// Alexa request handlers. All I/O goes through injected dependencies so the voice
// flows can be tested without AWS, Alexa or an AI provider.
import Alexa from "ask-sdk-core";
import { toSpeech, ModelResolutionError } from "@deeper-thinking/core";

const { getRequestType, getIntentName, getSlotValue } = Alexa;

const CHANNEL_LABEL = { voz: "voz", whatsapp: "WhatsApp", correo: "correo" };
const CHANNEL_FIELD = { whatsapp: "phone", correo: "email" };
const CHANNEL_SCOPE = { whatsapp: "alexa::profile:mobile_number:read", correo: "alexa::profile:email:read" };
const FIELD_LABEL = { phone: "tu número de celular", email: "tu correo" };

const ASK_CHANNEL = "¿Te lo leo cuando me preguntes, o te lo mando por WhatsApp o por correo?";
const REPROMPT_CHANNEL = "¿Por voz, WhatsApp o correo?";
const HELP =
  "Puedes pedirme que investigue un tema, que agende algo en tu calendario o que lea tus resultados. " +
  "Por ejemplo: agenda dentista el jueves a las cinco. ¿Qué necesitas?";

const isIntent = (h, name) => getRequestType(h.requestEnvelope) === "IntentRequest" && getIntentName(h.requestEnvelope) === name;
const session = (h) => h.attributesManager.getSessionAttributes();
const setSession = (h, attrs) => h.attributesManager.setSessionAttributes(attrs);
const end = (h, speech) => h.responseBuilder.speak(speech).withShouldEndSession(true).getResponse();
const ask = (h, speech, reprompt) => h.responseBuilder.speak(speech).reprompt(reprompt).getResponse();

function slotId(h, name) {
  const slot = h.requestEnvelope.request.intent?.slots?.[name];
  const match = slot?.resolutions?.resolutionsPerAuthority?.find((a) => a.status?.code === "ER_SUCCESS_MATCH");
  return match?.values?.[0]?.value?.id;
}

/**
 * @param {object} deps
 * @param {string} [deps.skillId]
 * @param {string} deps.portalUrl
 * @param {{userIdFrom(h): Promise<string|null>}} deps.identity
 * @param {object} deps.store         getUser, saveChannelPreference, createJob, recentJobs, markRead
 * @param {{enqueue(msg): Promise<void>}} deps.queue
 * @param {{email(h), phone(h)}} deps.contacts  → {value} | {denied: true} | {missing: true}
 * @param {(h, speech: string) => Promise<void>} deps.progressive
 * @param {{run({user, text}), executePending({user, pending})}} deps.agent
 * @param {() => string} deps.newId
 * @param {() => Date} [deps.now]
 */
export function buildSkill(deps) {
  const now = deps.now ?? (() => new Date());

  async function loadUser(h) {
    const userId = await deps.identity.userIdFrom(h);
    if (!userId) {
      return {
        response: h.responseBuilder
          .speak("Para usar Deeper Thinking, primero vincula tu cuenta. Te dejé una tarjeta en la app de Alexa.")
          .withLinkAccountCard()
          .withShouldEndSession(true)
          .getResponse(),
      };
    }
    const user = await deps.store.getUser(userId);
    if (!user?.ai?.provider || !user?.ai?.apiKeyEnc) {
      return {
        response: h.responseBuilder
          .speak("Tu cuenta ya está vinculada, pero falta elegir tu proveedor de inteligencia artificial. Termina la configuración en el portal; te dejé el enlace en la app de Alexa.")
          .withSimpleCard("Termina tu configuración", deps.portalUrl)
          .withShouldEndSession(true)
          .getResponse(),
      };
    }
    return { user };
  }

  function providerError(h, e) {
    if (e instanceof ModelResolutionError) {
      return end(h, "No encontré un modelo disponible con tu llave de API. Revisa tu cuenta con tu proveedor de inteligencia artificial.");
    }
    const byKind = {
      auth: "Tu proveedor de inteligencia artificial rechazó tu llave de API. Revísala en el portal.",
      rate_limit: "Tu proveedor de inteligencia artificial está limitando las solicitudes. Intenta en un minuto.",
    };
    if (e?.name === "ProviderError") {
      return end(h, byKind[e.kind] ?? "No pude comunicarme con tu proveedor de inteligencia artificial. Intenta de nuevo.");
    }
    throw e;
  }

  function askChannel(h, user, topic, reason) {
    const suggested = user.preferredChannel;
    setSession(h, { state: "choose_channel", topic, suggested });
    const intro =
      reason === "timeout"
        ? "Esto me está tomando más de lo normal, así que lo voy a investigar a fondo."
        : "Esto requiere investigar a fondo y tomará unos minutos.";
    const question = suggested ? `¿Te lo mando por ${CHANNEL_LABEL[suggested]}, como siempre?` : ASK_CHANNEL;
    return ask(h, `${intro} ${question}`, suggested ? "¿Sí o no?" : REPROMPT_CHANNEL);
  }

  async function startJob(h, user, topic, channel) {
    let destination;
    const field = CHANNEL_FIELD[channel];
    if (field) {
      const stored = user.contact?.[field];
      const found = stored ? { value: stored } : await deps.contacts[field](h);
      if (!found.value) {
        setSession(h, { state: "choose_channel", topic, suggested: "voz" });
        const rb = h.responseBuilder;
        if (found.denied) {
          rb.speak(
            `Para mandártelo por ${CHANNEL_LABEL[channel]} necesito permiso para ver ${FIELD_LABEL[field]}. ` +
              "Te dejé una tarjeta en la app de Alexa para darlo. Mientras tanto, ¿te lo leo cuando me preguntes?"
          ).withAskForPermissionsConsentCard([CHANNEL_SCOPE[channel]]);
        } else {
          rb.speak(`No encontré ${FIELD_LABEL[field]} en tu cuenta. Agrégalo en el portal. Mientras tanto, ¿te lo leo cuando me preguntes?`);
        }
        return rb.reprompt("¿Te lo leo cuando me preguntes?").getResponse();
      }
      destination = found.value;
    }

    const createdAt = now().toISOString();
    const job = { userId: user.userId, jobId: deps.newId(), topic, channel, destination, status: "queued", createdAt };
    await deps.store.createJob(job);
    await deps.queue.enqueue({ userId: job.userId, jobId: job.jobId, createdAt });
    if (user.preferredChannel !== channel) await deps.store.saveChannelPreference(user.userId, channel);
    setSession(h, {});

    const done =
      channel === "voz"
        ? "Perfecto, empiezo a investigar. Cuando quieras, dime: pídele a deeper thinking mis resultados."
        : `Perfecto, empiezo a investigar y te lo mando por ${CHANNEL_LABEL[channel]} cuando esté listo.`;
    return end(h, done);
  }

  const Launch = {
    canHandle: (h) => getRequestType(h.requestEnvelope) === "LaunchRequest",
    async handle(h) {
      const { response } = await loadUser(h);
      if (response) return response;
      return ask(h, "Hola. ¿Qué investigo o qué agendo?", "Puedes decir, por ejemplo: agenda dentista el jueves a las cinco.");
    },
  };

  const Agent = {
    canHandle: (h) => isIntent(h, "AgentIntent"),
    async handle(h) {
      const { user, response } = await loadUser(h);
      if (response) return response;
      const text = String(getSlotValue(h.requestEnvelope, "query") ?? "").trim();
      if (!text) return ask(h, "¿Qué quieres que investigue o agende?", "¿Qué necesitas?");

      deps.progressive(h, "Dame un segundo.").catch(() => {});

      let r;
      try {
        r = await deps.agent.run({ user, text });
      } catch (e) {
        return providerError(h, e);
      }

      if (r.status === "done") return end(h, toSpeech(r.speech || "Listo."));
      if (r.status === "needs_confirmation") {
        setSession(h, { state: "confirm_action", pending: r.pending });
        return ask(h, toSpeech(r.prompt || "¿Confirmo esta acción?"), "¿Lo confirmo? Dime sí o no.");
      }
      return askChannel(h, user, r.topic || text, r.status);
    },
  };

  const Yes = {
    canHandle: (h) => isIntent(h, "AMAZON.YesIntent"),
    async handle(h) {
      const s = session(h);
      if (s.state === "confirm_action" && s.pending) {
        const { user, response } = await loadUser(h);
        if (response) return response;
        setSession(h, {});
        try {
          return end(h, toSpeech(await deps.agent.executePending({ user, pending: s.pending })));
        } catch (e) {
          return providerError(h, e);
        }
      }
      if (s.state === "choose_channel" && s.suggested) {
        const { user, response } = await loadUser(h);
        if (response) return response;
        return startJob(h, user, s.topic, s.suggested);
      }
      return ask(h, "¿En qué te ayudo?", "¿Qué necesitas?");
    },
  };

  const No = {
    canHandle: (h) => isIntent(h, "AMAZON.NoIntent"),
    handle(h) {
      const s = session(h);
      if (s.state === "confirm_action") {
        setSession(h, {});
        return end(h, "De acuerdo, no hice ningún cambio.");
      }
      if (s.state === "choose_channel" && s.suggested) {
        setSession(h, { ...s, suggested: undefined });
        return ask(h, "Entonces, ¿te lo leo cuando me preguntes, o te lo mando por WhatsApp o por correo?", REPROMPT_CHANNEL);
      }
      return end(h, "De acuerdo.");
    },
  };

  const Channel = {
    canHandle: (h) => isIntent(h, "ChannelIntent"),
    async handle(h) {
      const channel = slotId(h, "canal");
      if (!CHANNEL_LABEL[channel]) return ask(h, "No entendí. ¿Por voz, WhatsApp o correo?", REPROMPT_CHANNEL);
      const { user, response } = await loadUser(h);
      if (response) return response;
      const s = session(h);
      if (s.state === "choose_channel" && s.topic) return startJob(h, user, s.topic, channel);
      await deps.store.saveChannelPreference(user.userId, channel);
      return end(h, `Listo. Las investigaciones largas te las entregaré por ${CHANNEL_LABEL[channel]}.`);
    },
  };

  const Results = {
    canHandle: (h) => isIntent(h, "ResultsIntent"),
    async handle(h) {
      const { user, response } = await loadUser(h);
      if (response) return response;
      const jobs = await deps.store.recentJobs(user.userId, 5);
      const ready = jobs.find((j) => j.status === "done" && !j.readAt);
      if (ready) {
        await deps.store.markRead(user.userId, ready);
        const label = CHANNEL_LABEL[ready.channel];
        const sent =
          ready.channel === "voz"
            ? ""
            : ready.deliveryError
              ? ` No pude mandarte el reporte por ${label}. Revisa tus datos en el portal.`
              : ` El reporte completo te lo mandé por ${label}.`;
        return end(h, `${toSpeech(`Sobre ${ready.topic}: ${ready.summary ?? ""}`, 3000)}${sent}`);
      }
      const running = jobs.find((j) => j.status === "queued" || j.status === "running");
      if (running) return end(h, `Sigo trabajando en ${toSpeech(running.topic, 200)}. Pregúntame en unos minutos.`);
      const failed = jobs.find((j) => j.status === "failed" && !j.readAt);
      if (failed) {
        await deps.store.markRead(user.userId, failed);
        return end(h, `No pude terminar la investigación sobre ${toSpeech(failed.topic, 200)}. Intenta pedirla de nuevo.`);
      }
      return end(h, "No tienes resultados nuevos.");
    },
  };

  const Help = {
    canHandle: (h) => isIntent(h, "AMAZON.HelpIntent"),
    handle: (h) => ask(h, HELP, "¿Qué necesitas?"),
  };

  const StopCancel = {
    canHandle: (h) => ["AMAZON.StopIntent", "AMAZON.CancelIntent", "AMAZON.NavigateHomeIntent"].some((n) => isIntent(h, n)),
    handle(h) {
      const pending = session(h).state === "confirm_action";
      setSession(h, {});
      return end(h, pending ? "De acuerdo, no hice ningún cambio." : "Hasta luego.");
    },
  };

  const Fallback = {
    canHandle: (h) => isIntent(h, "AMAZON.FallbackIntent"),
    handle: (h) =>
      ask(h, "No entendí. Prueba diciendo: investiga, y el tema; o agenda, y el evento.", "¿Qué necesitas?"),
  };

  const SessionEnded = {
    canHandle: (h) => getRequestType(h.requestEnvelope) === "SessionEndedRequest",
    handle: (h) => h.responseBuilder.getResponse(),
  };

  const Errors = {
    canHandle: () => true,
    handle(h, error) {
      // Never log request bodies or user data: only the error type and message.
      console.error(JSON.stringify({ level: "error", name: error?.name, message: error?.message }));
      return end(h, "Algo salió mal. Intenta de nuevo en un momento.");
    },
  };

  const builder = Alexa.SkillBuilders.custom()
    .addRequestHandlers(Launch, Agent, Yes, No, Channel, Results, Help, StopCancel, Fallback, SessionEnded)
    .addErrorHandlers(Errors)
    .withApiClient(new Alexa.DefaultApiClient());
  if (deps.skillId) builder.withSkillId(deps.skillId);
  return builder.create();
}
