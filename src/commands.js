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
  .setDescription('Gerencie limites e preferências do bot.')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false)
  .addSubcommand(subcommand =>
    subcommand.setName('ver').setDescription('Mostra as configurações atuais do bot.'),
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('definir')
      .setDescription('Atualiza limites como intervalo mínimo e tamanho máximo de anexos.')
      .addIntegerOption(option =>
        option
          .setName('intervalo_segundos')
          .setDescription('Tempo mínimo entre mensagens de um mesmo usuário.')
          .setRequired(false)
          .setMinValue(1)
          .setMaxValue(3600)
      )
      .addNumberOption(option =>
        option
          .setName('tamanho_max_mb')
          .setDescription('Tamanho máximo permitido para anexos (em megabytes).')
          .setRequired(false)
          .setMinValue(1)
          .setMaxValue(100)
      ),
  );

const commands = [chatCommand.toJSON(), adminConfigCommand.toJSON()];

module.exports = { commands, attachmentOptionNames };
