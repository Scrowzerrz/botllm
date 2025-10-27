const { SlashCommandBuilder } = require('discord.js');

const attachmentOptionNames = ['arquivo1', 'arquivo2', 'arquivo3'];

const chatCommand = new SlashCommandBuilder()
  .setName('chat')
  .setDescription('Converse com o Gemini 2.5 Pro.')
  .addStringOption(option =>
    option
      .setName('mensagem')
      .setDescription('Texto a ser enviado para o modelo.')
      .setRequired(true)
      .setMaxLength(1000)
  )
  .addBooleanOption(option =>
    option
      .setName('usar_grounding')
      .setDescription('Habilita busca na web para respostas atualizadas.')
      .setRequired(false)
  );

attachmentOptionNames.forEach(name => {
  chatCommand.addAttachmentOption(option =>
    option
      .setName(name)
      .setDescription('Arquivo opcional (imagem, PDF, etc.) para enviar ao modelo.')
      .setRequired(false)
  );
});

const commands = [chatCommand.toJSON()];

module.exports = { commands, attachmentOptionNames };
