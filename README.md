# Deeper Thinking for Alexa

Agente de voz para Alexa que investiga, responde y agenda en tu calendario usando el modelo de IA que tú elijas.

> "Alexa, pídele a deeper thinking que agende dentista el jueves a las cinco."
> "Alexa, pídele a deeper thinking que investigue las ventajas de los paneles solares."

- **Agnóstico de modelo:** Anthropic, OpenAI o Google. El usuario elige la empresa y pega su llave; los modelos se eligen solos (uno ligero para responder rápido, uno más capaz para investigar a fondo).
- **Voz primero:** las preguntas rápidas se responden al momento; las investigaciones largas se leen después o llegan por WhatsApp o correo.
- **Calendario de Apple (iCloud):** consultar, buscar huecos, agregar y borrar eventos. Borrar siempre pide confirmación.

Diseño completo y decisiones: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Estructura

```
packages/core           agente, proveedores de IA, registro de modelos, herramientas
packages/calendar-mcp   servidor MCP de Apple Calendar (CalDAV)
packages/skill          skill de Alexa: modelo de interacción es-MX, manifiesto y Lambda
docs/                   arquitectura
```

## Desarrollo

Requiere Node.js 20+.

```bash
npm install
npm test
```

## Variables de entorno (Lambda de la skill)

| Variable | Descripción |
| --- | --- |
| `SKILL_ID` | ID de la skill en la consola de Alexa |
| `USERS_TABLE`, `JOBS_TABLE` | Tablas de DynamoDB |
| `JOBS_QUEUE_URL` | Cola SQS de investigaciones |
| `COGNITO_DOMAIN` | Dominio del user pool usado para vincular cuentas |
| `PORTAL_URL` | Portal de configuración |
| `SEARCH_API_KEY` | Llave de Tavily para búsquedas rápidas |
| `AGENT_DEADLINE_MS` | Presupuesto de tiempo por turno de voz (por defecto 6000) |
| `MODEL_REGISTRY_JSON` | Opcional: ajustes al registro de modelos |

## Estado

Versión 0.1: núcleo del agente, calendario y skill con pruebas. Siguiente: worker de investigación, portal e infraestructura. Ver la sección *Pendiente* de la arquitectura.

## Licencia

[MIT](LICENSE)
