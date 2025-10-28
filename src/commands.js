const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const attachmentOptions = [
  {
    name: 'anexo_principal',
    description: 'Arquivo principal (imagem ou PDF) que o bot deve considerar.',
  },
  {
    name: 'anexo_extra_1',
    description: 'Arquivo complementar opcional para dar mais contexto.',
  },
  {
    name: 'anexo_extra_2',
    description: 'Segundo arquivo complementar opcional.',
  },
];

const attachmentOptionNames = attachmentOptions.map(option => option.name);

const chatCommand = new SlashCommandBuilder()
  .setName('chat')
  .setDescription('Converse com o Gemini 2.5 Pro.')
  .addStringOption(option =>
    option
      .setName('mensagem')
      .setDescription('Pergunta ou instrução principal para o modelo.')
      .setRequired(false)
      .setMaxLength(1500)
  )
  .addStringOption(option =>
    option
      .setName('pesquisa_web')
      .setDescription('Decida se o bot deve pesquisar na web antes de responder.')
      .setRequired(false)
      .addChoices(
        { name: 'Pesquisar na web', value: 'ativar' },
        { name: 'Não pesquisar', value: 'desativar' },
      )
  );

attachmentOptions.forEach(({ name, description }) => {
  chatCommand.addAttachmentOption(option =>
    option
      .setName(name)
      .setDescription(description)
      .setRequired(false)
  );
});

const adminConfigCommand = new SlashCommandBuilder()
  .setName('configurar')
  .setDescription('Abra o painel de configuração do bot.')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false);

const commands = [chatCommand.toJSON(), adminConfigCommand.toJSON()];

module.exports = { commands, attachmentOptionNames };
