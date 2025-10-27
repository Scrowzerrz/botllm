require('dotenv').config();
const { REST, Routes } = require('discord.js');
const { commands } = require('./commands');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;

if (!DISCORD_TOKEN) {
  console.error('Configure a variavel de ambiente DISCORD_TOKEN antes de executar este script.');
  process.exit(1);
}

if (!DISCORD_CLIENT_ID) {
  console.error('Configure a variavel de ambiente DISCORD_CLIENT_ID antes de executar este script.');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

(async () => {
  try {
    if (DISCORD_GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID), {
        body: commands,
      });
      console.log('Comandos de guild atualizados com sucesso.');
    } else {
      await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: commands });
      console.log('Comandos globais atualizados com sucesso.');
    }
  } catch (error) {
    console.error('Falha ao registrar comandos de barra:', error);
    process.exit(1);
  }
})();
