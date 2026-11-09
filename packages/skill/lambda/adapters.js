// Alexa service APIs used by the skill.

async function readProfile(fn) {
  try {
    const value = await fn();
    return value ? { value } : { missing: true };
  } catch (e) {
    if (e?.statusCode === 403) return { denied: true };
    if (e?.statusCode === 204) return { missing: true };
    throw e;
  }
}

/** Contact data from the user's Amazon profile; read on demand, never stored (Alexa policy). */
export const alexaContacts = {
  email: (h) => readProfile(() => h.serviceClientFactory.getUpsServiceClient().getProfileEmail()),
  phone: (h) =>
    readProfile(async () => {
      const n = await h.serviceClientFactory.getUpsServiceClient().getProfileMobileNumber();
      return n?.phoneNumber ? `${n.countryCode ?? ""}${n.phoneNumber}`.replace(/[^\d+]/g, "") : undefined;
    }),
};

/** "Dame un segundo" while the agent works (counts toward Alexa's ~8 s budget). */
export async function alexaProgressive(h, speech) {
  await h.serviceClientFactory.getDirectiveServiceClient().enqueue({
    header: { requestId: h.requestEnvelope.request.requestId },
    directive: { type: "VoicePlayer.Speak", speech: `<speak>${speech}</speak>` },
  });
}

export const accessTokenOf = (h) => h.requestEnvelope.context?.System?.user?.accessToken;
