Habla con un modelo live2d.

Ejecuta localmente en el navegador o usando conexión proxy backend con Openai, Ollama, etc.

Prueba en línea https://live2d-ai-chat.hitorisama.org/

![image](https://github.com/user-attachments/assets/d5185348-a251-4ff8-aa3e-e2ffcaa03bed)

# Características

1. Mostrar modelo live2d 🆗
2. Cambiar automáticamente la expresión del modelo
3. Cambiar automáticamente el movimiento del modelo 🆗
4. Habla a texto 🆗 (Web Speech API)
5. Texto a voz 🆗 (navegador: vits-web; backend: node-edge-tts)
6. Estilo de voz
7. Subtítulos de IA y usuario 🆗
8. Memoria a largo plazo
9. Modelo de chat personalizado
10. Hablar primero / Encontrar temas 🆗
11. Cambiar modelo, expresión y movimiento
12. Otras funciones: jugar juegos, cantar, buscar en Google, etc.

# ¿Cómo desarrollar?

1. Instala [ollama](https://ollama.com/) y descarga un modelo que te guste
2. Instala nodejs, pnpm, bun(opcional)
3. git clone https://github.com/zoollcar/live2d-AI-chat
4. cd live2d-AI-chat & pnpm install & cd backend & pnpm install
5. Ejecuta el backend: cd backend & cp .env.local.example .env.local & node index.js
6. Ejecuta la aplicación: cd live2d-AI-chat & pnpm run dev

# ¿Cómo generar el ejecutable? (Actualmente tiene algunos problemas, no funciona)

1. Instala nodejs, pnpm, bun
2. git clone https://github.com/zoollcar/live2d-AI-chat
3. cd live2d-AI-chat & pnpm install & cd backend & bun install
4. Genera el backend integrado al frontend: cd backend & bun run build:windows
5. cd live2d-AI-chat & pnpm run tauri:build

# Configuración

Modelo LLM del frontend: [LLMChatWebLLM](./src/models/llm/LLMChatWebLLM.ts)

Modelo TTS del frontend: [vitsWeb](src/models/tts/vitsWeb.ts)

Backend: [.env.local.example](backend/.env.local.example)

# Créditos
Modelo live2d: [Tianyelulu](https://tianyelulu.booth.pm)
