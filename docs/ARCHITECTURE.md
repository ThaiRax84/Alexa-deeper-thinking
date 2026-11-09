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
                               DynamoDB (secretos cifrados con KMS) ◀── registro de modelos
Investigación larga: SQS ──▶ Worker (modelo deep) ──▶ voz | WhatsApp | correo
```

| Paquete | Responsabilidad |
| --- | --- |
| `packages/core` | Bucle del agente, adaptadores de proveedor, registro de modelos, `ToolHub`, política de confirmación, prompts |
| `packages/calendar-mcp` | Servidor MCP de Apple Calendar (iCloud/CalDAV): listar, buscar huecos, agregar y borrar eventos |
| `packages/skill` | Modelo de interacción es-MX, manifiesto y Lambda de Alexa |
| `packages/worker` *(siguiente)* | Investigación profunda y entrega |
| `packages/portal` *(siguiente)* | Vinculación de cuenta y configuración |
| `infra/` *(siguiente)* | Plantilla AWS SAM |

## Flujos

**Pregunta rápida o calendario (síncrono, ~3–5 s).** Identidad (Cognito) → descifrar llave (KMS, en caché) → modelo ligero con herramientas → respuesta. Al agregar un evento la confirmación sale de una plantilla, sin segunda llamada al modelo.

**Acción destructiva.** El agente nunca ejecuta una herramienta marcada `destructiveHint`. Devuelve `needs_confirmation`, Alexa pregunta y solo con `AMAZON.YesIntent` se llama `executeConfirmed`. La regla vive en `ToolHub`, fuera del modelo, así que un prompt no puede saltársela.

**Investigación larga.** El modelo ligero llama `start_deep_research` (o se agota el tiempo). Alexa pregunta el canal: leerlo después, WhatsApp o correo; recuerda la elección para ofrecerla la próxima vez. El trabajo va a SQS y el worker usa el modelo deep. Por voz, el usuario dice "mis resultados".

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

- Llaves de API y app-passwords de iCloud cifrados con KMS y contexto de cifrado `{userId}`; solo la Lambda los descifra y nunca se registran.
- Los errores de proveedor no incluyen encabezados ni cuerpos de petición.
- El servidor de calendario recibe solo las variables que necesita y mantiene su protección de URLs: solo borra eventos dentro de los calendarios del propio usuario.
- Correo y celular del perfil de Amazon se leen al momento de usarlos, como pide la política de Alexa.

## Decisiones

1. **Custom Skill clásica, no Alexa+.** Los SDKs de Alexa+ están en acceso anticipado. Revisar cuando haya acceso: el Agent Core se reutiliza tal cual.
2. **Calendario como subproceso stdio.** Reutiliza el servidor MCP sin cambios ni exponerlo a internet. Coste: ~300 ms al arrancar, amortizado con `CalendarPool` en Lambdas calientes.
3. **La herramienta `start_deep_research` como traspaso.** El modelo ligero decide en la misma llamada si responde o delega; evita un clasificador aparte (~1 s).
4. **Llave del usuario (BYOK).** El costo de IA es de cada usuario y el operador no paga por uso.
5. **Nombre en tienda "Deeper Thinking for Alexa", invocación "deeper thinking".** La política de Amazon no permite "Alexa" en la invocación y solo lo acepta como referencia en el nombre.

## Pendiente

- Worker de investigación y entrega (WhatsApp Cloud API con plantilla aprobada; SES para correo).
- Portal de vinculación (Cognito + página estática) y cifrado de secretos al guardarlos.
- Plantilla SAM, íconos, política de privacidad y términos para certificación.
- Notificación de "resultados listos" en el dispositivo.
