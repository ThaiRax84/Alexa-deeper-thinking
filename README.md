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
packages/aws            DynamoDB, S3, SQS, SSM y cifrado compartidos
packages/skill          skill de Alexa: modelo de interacción es-MX, manifiesto y Lambda
packages/worker         investigación profunda y entrega (voz, correo, WhatsApp)
packages/portal         portal de configuración, aviso de privacidad y términos
infra/                  plantilla AWS SAM
scripts/build.mjs       empaqueta cada Lambda con esbuild
docs/                   arquitectura y guía de despliegue
```

## Desarrollo

Requiere Node.js 20.10+ (22 recomendado).

```bash
npm install
npm test
```

## Despliegue

```bash
npm run build
sam deploy --guided -t infra/template.yaml
```

Paso a paso (AWS, consola de Alexa, correo y WhatsApp): [docs/DEPLOY.md](docs/DEPLOY.md).

## Estado

Versión 0.2: skill, worker de investigación, portal e infraestructura listos para desplegar. Pendientes en la sección *Pendiente* de la arquitectura.

## Licencia

[MIT](LICENSE)
