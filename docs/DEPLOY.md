# Despliegue

Guía para poner Deeper Thinking for Alexa en una cuenta de AWS (plan gratuito) y publicarla en la tienda de Alexa para México.

## 0. Requisitos

- Cuenta de AWS y [AWS CLI](https://docs.aws.amazon.com/cli/) + [SAM CLI](https://docs.aws.amazon.com/serverless-application-model/) configurados. Región recomendada: **us-east-1** (la de Alexa para Norteamérica).
- Node.js 22 y `openssl`.
- Cuenta en [developer.amazon.com](https://developer.amazon.com) para crear la skill.
- Opcional: llave de [Tavily](https://tavily.com) para búsquedas web, identidad verificada en Amazon SES para correo y cuenta de Meta Business para WhatsApp.

## 1. Secretos del operador (SSM)

Todo vive bajo `/deeper-thinking/` como SecureString (sin costo mensual):

```bash
aws ssm put-parameter --name /deeper-thinking/master-key --type SecureString \
  --value "$(openssl rand -base64 32)"
aws ssm put-parameter --name /deeper-thinking/search-api-key --type SecureString --value "tvly-..."   # opcional
aws ssm put-parameter --name /deeper-thinking/whatsapp-token --type SecureString --value "EAA..."    # opcional
```

> **No cambies ni borres `master-key`.** Cifra las llaves de todos los usuarios; si se pierde, cada usuario tendrá que volver a configurarlas.

## 2. Crear la skill

1. En la consola de Alexa: **Create Skill** → nombre *Deeper Thinking for Alexa* → idioma **Spanish (MX)** → modelo **Custom** → backend **Provision your own**.
2. Copia el **Skill ID** (`amzn1.ask.skill...`).
3. **Interaction Model → JSON Editor**: pega `packages/skill/skill-package/interactionModels/custom/es-MX.json` y construye el modelo.
4. **Tools → Account Linking**: activa la vinculación y copia las tres **Alexa Redirect URLs** que aparecen abajo (las necesitas en el paso 3).

## 3. Desplegar en AWS

```bash
npm ci
npm test
npm run build
sam deploy --guided -t infra/template.yaml
```

Parámetros que pide:

| Parámetro | Valor |
| --- | --- |
| `SkillId` | El del paso 2 |
| `CognitoDomainPrefix` | Único y en minúsculas, p. ej. `deeper-thinking-tunombre` |
| `AlexaRedirectUrls` | Las tres URLs del paso 2, separadas por comas |
| `EmailFrom` | Remitente verificado en SES (vacío lo desactiva) |
| `WhatsAppPhoneNumberId` | ID del número en Meta (vacío lo desactiva) |

Al terminar, las salidas (`Outputs`) traen todo lo que sigue.

## 4. Conectar la skill con AWS

En la consola de Alexa:

- **Endpoint** → AWS Lambda ARN → *Default Region*: `SkillFunctionArn`.
- **Account Linking** → *Auth Code Grant*:
  - Authorization URI: `AccountLinkingAuthorizationUri`
  - Access Token URI: `AccountLinkingAccessTokenUri`
  - Client ID: `AccountLinkingClientId`
  - Client Secret: ejecuta el comando de `AccountLinkingClientSecretCommand`
  - Authentication Scheme: *HTTP Basic*
  - Scopes: `openid` y `email`
- **Tools → Permissions**: activa *Customer Email Address* y *Customer Mobile Number*.

## 5. Probar

1. Abre `PortalUrl`, crea tu cuenta, elige tu empresa de IA, pega tu llave y, si quieres, conecta tu calendario.
2. En la app de Alexa: **Más → Skills → Tus skills → Dev** → Deeper Thinking → **Vincular cuenta** con la misma cuenta.
3. En la pestaña **Test** de la consola (modo *Development*) o en tu Echo: *"Alexa, pídele a deeper thinking que agende prueba mañana a las diez"*.

Los registros están en CloudWatch Logs de cada función. Nunca contienen llaves ni el contenido de las peticiones.

## 6. Correo (Amazon SES)

1. Verifica el remitente o, mejor, tu dominio en SES (con DKIM).
2. Mientras la cuenta esté en *sandbox*, SES solo envía a direcciones verificadas. Para enviar a cualquier usuario, solicita **production access** desde la consola de SES.

## 7. WhatsApp (Meta Cloud API)

1. En [developers.facebook.com](https://developers.facebook.com) crea una app tipo *Business* y agrega el producto **WhatsApp**.
2. Registra el número que enviará los mensajes y copia su **Phone number ID** (parámetro `WhatsAppPhoneNumberId`).
3. Crea un **System User** en Meta Business con permiso `whatsapp_business_messaging` y genera un token permanente → guárdalo en `/deeper-thinking/whatsapp-token`.
4. Crea y envía a aprobación esta plantilla:

| Campo | Valor |
| --- | --- |
| Nombre | `investigacion_lista` |
| Categoría | Utility |
| Idioma | Spanish (MEX) — `es_MX` |
| Encabezado | Document |
| Cuerpo | `Tu investigación sobre {{1}} está lista. Resumen: {{2}} El reporte completo va adjunto.` |
| Pie | `Deeper Thinking for Alexa` |

Meta cobra cada plantilla enviada fuera de la ventana de 24 horas de conversación; revisa sus tarifas para México.

## 8. Certificación y publicación

- **Íconos** de 108×108 y 512×512 px: súbelos en *Distribution* (o reemplaza `REPLACE_ME` en `skill.json` si usas ASK CLI).
- **Aviso de privacidad** y **términos**: `PortalUrl` + `privacidad` y `terminos`. Antes, completa los datos marcados con `[ ]` en `packages/portal/public/` y haz que los revise un abogado.
- **Instrucciones de prueba**: crea una cuenta de prueba en el portal con una llave de IA con límite de gasto bajo y comparte sus credenciales en las notas de certificación.
- **Disponibilidad**: México.

## Costos esperados

| Servicio | Uso típico | Costo |
| --- | --- | --- |
| Lambda, SQS | Miles de peticiones al mes | Dentro de la capa siempre gratuita |
| DynamoDB | 2 tablas de 5 RCU/5 WCU | Dentro de la capa siempre gratuita (25/25) |
| Cognito | Hasta 10,000 usuarios activos al mes | Sin costo en el plan Essentials |
| S3, SES, CloudWatch | Reportes de 30 días, correos | Centavos; cubiertos por los créditos del plan gratuito |
| IA | Cada usuario con su llave | Lo paga cada usuario |
| Tavily, WhatsApp | Según uso | Capa gratuita de Tavily; WhatsApp por mensaje |

El plan gratuito de AWS dura 6 meses o hasta agotar los créditos. Después hay que pasar a plan de pago para no perder la cuenta; con este volumen, el costo sigue siendo cercano a cero.
