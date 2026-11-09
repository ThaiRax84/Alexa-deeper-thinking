# Arquitectura

Deeper Thinking for Alexa es una skill multiusuario: cada persona vincula su cuenta, elige su empresa de IA, pega su llave de API y, opcionalmente, conecta su calendario de Apple. Después le habla a Alexa para investigar, preguntar y agendar.

## Restricciones que mandan el diseño

| Restricción | Consecuencia |
| --- | --- |
| Alexa da ~8 s por respuesta; las respuestas progresivas no amplían ese tiempo | Ruta rápida con modelo ligero y presupuesto de 6 s; lo largo es asíncrono |
| Los SDKs de IA de Alexa+ están en acceso anticipado | Custom Skill clásica; el núcleo no depende de Alexa para migrar después |
| Texto libre solo con `AMAZON.SearchQuery` y frase de apoyo | Un `AgentIntent` con muchas frases ("investiga…", "agenda…") |
| Nombres de modelo cambian cada pocos meses | El registro guarda familias, no IDs |
| El usuario no debe configurar nada técnico | Solo elige empresa y pega su llave; correo y celular vienen del perfil de Amazon |

## Componentes

```
Usuario ──voz──▶ Alexa ──▶ Skill (Lambda) ──▶ Agent Core ──▶ calendar-mcp (subproceso) ──CalDAV──▶ iCloud
                  │                              │      └─▶ web_search (Tavily)
  App de Alexa ── vinculación ──▶ Portal (Cognito)
                                    │ empresa IA + llave, canal, calendario
                                    ▼
                               DynamoDB (secretos cifrados AES-GCM) ◀── registro de modelos
Investigación larga: SQS ──▶ Worker (modelo deep + web_search/read_page) ──▶ S3 ──▶ voz | WhatsApp | correo
```

| Paquete | Responsabilidad |
| --- | --- |
| `packages/core` | Bucle del agente, adaptadores de proveedor, registro de modelos, `ToolHub`, política de confirmación, prompts |
| `packages/calendar-mcp` | Servidor MCP de Apple Calendar (iCloud/CalDAV): listar, buscar huecos, agregar y borrar eventos |
| `packages/aws` | DynamoDB, S3, SQS, SSM, cifrado de secretos e identidad de Cognito, compartidos por las tres Lambdas |
| `packages/skill` | Modelo de interacción es-MX, manifiesto y Lambda de Alexa |
| `packages/worker` | Investigación profunda con el modelo capaz y entrega por voz, correo (SES) o WhatsApp |
| `packages/portal` | Página de configuración, API, aviso de privacidad y términos (Lambda Function URL) |
| `infra/` | Plantilla AWS SAM; `scripts/build.mjs` empaqueta cada Lambda con esbuild |

## Flujos

**Pregunta rápida o calendario (síncrono, ~3–5 s).** Identidad (Cognito) → descifrar llave (AES-GCM, llave maestra en SSM) → modelo ligero con herramientas → respuesta. Al agregar un evento la confirmación sale de una plantilla, sin segunda llamada al modelo.

**Acción destructiva.** El agente nunca ejecuta una herramienta marcada `destructiveHint`. Devuelve `needs_confirmation`, Alexa pregunta y solo con `AMAZON.YesIntent` se llama `executeConfirmed`. La regla vive en `ToolHub`, fuera del modelo, así que un prompt no puede saltársela.

**Investigación larga.** El modelo ligero llama `start_deep_research` (o se agota el tiempo). Alexa pregunta el canal: leerlo después, WhatsApp o correo; recuerda la elección para ofrecerla la próxima vez. El trabajo va a SQS y el worker usa el modelo deep con búsqueda y lectura de páginas (hasta 12 min; si se acaba el tiempo, redacta con lo que tiene). El resultado se guarda en S3 antes de entregarlo, así un reintento no repite la investigación. Si la entrega falla de forma permanente, el resumen sigue disponible por voz con "mis resultados".

**Configuración.** El usuario entra al portal con la misma cuenta de Cognito con que vinculó la skill. La llave de IA se verifica contra el proveedor y los modelos se eligen en ese momento; las credenciales de iCloud se prueban listando sus calendarios. Nada se guarda si la verificación falla.

## Modelos

El usuario solo elige la empresa. Al conectar la llave se consulta la lista de modelos del proveedor y se elige el más nuevo de cada familia:

| Empresa | Ligero (ruteo, voz) | Deep (investigación) | Adaptador |
| --- | --- | --- | --- |
| Anthropic | familia Haiku | familia Opus | Messages API |
| OpenAI | Luna / mini / nano | Sol / Astra | Chat Completions |
| Google | Flash (sin Lite) | Pro | Endpoint compatible con OpenAI |

Un operador puede fijar un ID (`pinned`), cambiar familias o quitar una empresa con `MODEL_REGISTRY_JSON`, sin redeploy de código. Para agregar otra empresa compatible con OpenAI basta una entrada en el registro.

## Datos

- **Users** (pk `userId` = `sub` de Cognito): proveedor, llave cifrada, modelos resueltos, zona horaria, canal preferido, contacto opcional, calendario.
- **Jobs** (pk `userId`, sk `createdAt#jobId`, TTL 30 días): tema, canal, destino, estado, resumen, reporte.

## Seguridad

- Llaves de API y app-passwords de iCloud cifrados con AES-256-GCM; el `userId` va como dato autenticado, así que un texto cifrado copiado a otro usuario no se puede descifrar. La llave maestra vive en un SecureString de SSM. Nunca se devuelven al navegador ni se registran.
- El portal valida el token de Cognito (firma, emisor, cliente y expiración) en cada llamada y sirve sus páginas con CSP estricta.
- Los correos se generan escapando todo el HTML que viene de páginas web; solo se conservan enlaces http(s).
- Los errores de proveedor no incluyen encabezados ni cuerpos de petición.
- El servidor de calendario recibe solo las variables que necesita y mantiene su protección de URLs: solo borra eventos dentro de los calendarios del propio usuario.
- Correo y celular del perfil de Amazon se leen al momento de usarlos, como pide la política de Alexa.

## Decisiones

1. **Custom Skill clásica, no Alexa+.** Los SDKs de Alexa+ están en acceso anticipado. Revisar cuando haya acceso: el Agent Core se reutiliza tal cual.
2. **Calendario como subproceso stdio.** Reutiliza el servidor MCP sin cambios ni exponerlo a internet. Coste: ~300 ms al arrancar, amortizado con `CalendarPool` en Lambdas calientes.
3. **La herramienta `start_deep_research` como traspaso.** El modelo ligero decide en la misma llamada si responde o delega; evita un clasificador aparte (~1 s).
4. **Llave del usuario (BYOK).** El costo de IA es de cada usuario y el operador no paga por uso.
5. **Nombre en tienda "Deeper Thinking for Alexa", invocación "deeper thinking".** La política de Amazon no permite "Alexa" en la invocación y solo lo acepta como referencia en el nombre.
6. **AES-GCM con llave en SSM en lugar de KMS.** Un SecureString no tiene costo mensual; una llave KMS cuesta ~1 USD al mes. Si el proyecto crece, cambiar `aesSecrets` por KMS es local al paquete `aws`.
7. **Portal en una Lambda Function URL.** Sin API Gateway ni CloudFront: una sola función sirve la página y la API, sin costo fijo.
8. **DynamoDB aprovisionado (5/5 por tabla).** Queda dentro de la capa siempre gratuita; bajo demanda no lo está.

## Pendiente

- Notificación de "resultados listos" en el dispositivo (Proactive Events API).
- Iniciar sesión con Amazon (Login with Amazon) para no crear otra contraseña.
- Íconos de la skill y revisión legal del aviso de privacidad y los términos.
- Despliegue real y pruebas de extremo a extremo en un Echo (ver [DEPLOY.md](DEPLOY.md)).
