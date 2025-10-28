const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const attachmentOptions = [
  {
    name: 'arquivo-principal',
    description: 'Arquivo principal (imagem ou PDF) que o bot deve considerar.',
  },
  {
    name: 'arquivo-extra',
    description: 'Arquivo extra opcional para dar mais contexto.',
  },
  {
    name: 'arquivo-extra-2',
    description: 'Segundo arquivo extra opcional.',
  },
];

const attachmentOptionNames = attachmentOptions.map(option => option.name);

const chatCommand = new SlashCommandBuilder()
  .setName('chat')
  .setDescription('Converse com o Gemini 2.5 Pro com anexos opcionais.')
  .addStringOption(option =>
    option
      .setName('mensagem')
      .setDescription('Mensagem principal que deseja enviar para o Gemini.')
      .setRequired(false)
      .setMaxLength(1500),
  )
  .addBooleanOption(option =>
    option
      .setName('pesquisa')
      .setDescription('Ativa pesquisa na web antes de responder.')
      .setRequired(false),
  );

attachmentOptions.forEach(({ name, description }) => {
  chatCommand.addAttachmentOption(option =>
    option
      .setName(name)
      .setDescription(description)
      .setRequired(false),
  );
});

const adminConfigCommand = new SlashCommandBuilder()
  .setName('configurar')
  .setDescription('Abra o painel de configuracao do bot.')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false);

const commands = [chatCommand.toJSON(), adminConfigCommand.toJSON()];

module.exports = { commands, attachmentOptionNames };
