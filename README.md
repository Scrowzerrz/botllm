# Bot do Discord com Gemini 2.5 Pro

Este projeto cria um bot do Discord em Node.js que permite conversar com o modelo **Gemini 2.5 Pro**. Ele responde a mensagens privadas ou mencoes diretas em canais, mantendo um pequeno historico para deixar a conversa mais natural.

## Pre-requisitos

- Node.js 18 ou superior
- Uma aplicacao/bot registrada no [Portal de Desenvolvedores do Discord](https://discord.com/developers/applications)
- Uma chave de API valida do [Google AI Studio](https://aistudio.google.com/app/apikey) habilitada para o modelo `gemini-2.5-pro`

## Configuracao

1. Instale as dependencias:

   ```bash
   npm install
   ```

2. Crie um arquivo `.env` na raiz do projeto com as credenciais:

   ```ini
   DISCORD_TOKEN=coloque_o_token_do_bot_aqui
   DISCORD_CLIENT_ID=id_da_aplicacao_no_discord
   DISCORD_GUILD_ID=id_do_servidor_para_comando_local_opcional
   GEMINI_API_KEY=coloque_sua_chave_gemini_aqui
   RATE_LIMIT_MS=10000
    MAX_ATTACHMENT_BYTES=8388608
   ```

   - `DISCORD_GUILD_ID` e opcional. Defina para registrar o comando apenas em um servidor especifico (mais rapido para testar). Deixe em branco para registrar de forma global.
   - `RATE_LIMIT_MS` controla o tempo minimo (em milissegundos) entre requisicoes por usuario. O padrao e 10000 ms (10 segundos).
   - `MAX_ATTACHMENT_BYTES` limita o tamanho de cada anexo enviado ao modelo (padrao: 8 MB).
   - Garanta que o bot tenha a intent *Direct Messages* habilitada no portal do Discord.
   - Gere o link de convite com os escopos `bot` e `applications.commands`, por exemplo:

     ```
     https://discord.com/api/oauth2/authorize?client_id=SEU_CLIENT_ID&permissions=274877990912&scope=bot%20applications.commands
     ```

     Substitua `SEU_CLIENT_ID` e ajuste as permissoes conforme necessario.

3. O bot registra automaticamente o comando `/chat` quando inicia (usa `DISCORD_GUILD_ID` se definido, ou global caso contrario). Se preferir acionar manualmente, execute:

   ```bash
   npm run deploy
   ```

   - Com `DISCORD_GUILD_ID`, o comando aparece quase instantaneamente no servidor selecionado.
   - Como comando global pode levar alguns minutos ate o Discord propagar.

## Executando

Inicie o bot com:

```bash
npm start
```

Quando estiver online:

- Use o comando `/chat` e preencha o campo **mensagem** com a pergunta ou texto que deseja enviar ao Gemini.
- Opcionalmente, anexe ate 3 arquivos (imagens ou PDFs) para fornecer contexto adicional. Eles sao enviados ao modelo junto com a mensagem.
- Marque o campo **usar_grounding** quando quiser que o modelo consulte resultados atualizados via busca do Google antes de responder.
- O comando funciona em DMs (se permitidas) e em servidores onde o bot estiver presente.

O bot mantem ate 10 interacoes recentes por canal ou DM, aplica o limite configurado para evitar excesso de chamadas na API e oferece suporte opcional a anexos/grounding em cada requisicao.
