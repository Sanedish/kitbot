const { Events } = require('discord.js');
const { getConfig } = require('../config-store');

const DEBUG_EVENT_TIMEOUT_MS = 60_000;

class ModmailDebugCog {
    constructor(client) {
        this.client = client;
        this.started = false;
        this.pendingPings = new Map();
        this.boundHandleMessageCreate = message => {
            void this.handleMessageCreate(message).catch(error => {
                console.error(`[MODMAIL-DEBUG] MessageCreate handler failed: ${formatError(error)}`);
            });
        };
        this.boundHandleLauncherSent = payload => {
            void this.handleLauncherSent(payload).catch(error => {
                console.error(`[MODMAIL-DEBUG] LauncherSent handler failed: ${formatError(error)}`);
            });
        };
        this.boundHandleLauncherFailed = payload => {
            void this.handleLauncherFailed(payload).catch(error => {
                console.error(`[MODMAIL-DEBUG] LauncherFailed handler failed: ${formatError(error)}`);
            });
        };
        this.boundHandleTicketCreateFailed = payload => {
            void this.handleTicketCreateFailed(payload).catch(error => {
                console.error(`[MODMAIL-DEBUG] TicketCreateFailed handler failed: ${formatError(error)}`);
            });
        };
    }

    start() {
        if (this.started) return;

        this.client.on(Events.MessageCreate, this.boundHandleMessageCreate);
        this.client.on('modmail:launcherSent', this.boundHandleLauncherSent);
        this.client.on('modmail:launcherFailed', this.boundHandleLauncherFailed);
        this.client.on('modmail:ticketCreateFailed', this.boundHandleTicketCreateFailed);
        this.started = true;
    }

    stop() {
        if (!this.started) return;

        this.client.off(Events.MessageCreate, this.boundHandleMessageCreate);
        this.client.off('modmail:launcherSent', this.boundHandleLauncherSent);
        this.client.off('modmail:launcherFailed', this.boundHandleLauncherFailed);
        this.client.off('modmail:ticketCreateFailed', this.boundHandleTicketCreateFailed);
        this.pendingPings.clear();
        this.started = false;
    }

    async handleMessageCreate(message) {
        if (message.author.bot || message.guild) return;
        if (!isDebugUser(message.author.id)) return;
        if (isCommandLike(message.content)) return;

        const modmailCog = this.client.cogs?.modmail;
        if (!modmailCog?.isEnabled?.()) return;
        if (modmailCog.getTicketByUserId?.(message.author.id)?.open) return;

        const existingPending = this.pendingPings.get(message.author.id);
        if (existingPending && Date.now() - existingPending.createdAt < DEBUG_EVENT_TIMEOUT_MS) {
            return;
        }

        this.pendingPings.set(message.author.id, {
            channelId: message.channel.id,
            createdAt: Date.now()
        });
    }

    async handleLauncherSent(payload) {
        const pending = this.pendingPings.get(payload.userId);
        if (!pending) return;
        this.pendingPings.delete(payload.userId);
    }

    async handleLauncherFailed(payload) {
        const pending = this.pendingPings.get(payload.userId);
        if (!pending) return;

        const dmChannel = await this.client.channels.fetch(pending.channelId).catch(() => null);
        if (dmChannel?.isTextBased()) {
            await dmChannel.send(`Modmail launcher failed while opening the DM interface.\n${payload.error || 'Unknown error'}`).catch(error => {
                console.error(`[MODMAIL-DEBUG] Failed to send launcher error to ${payload.userId}: ${formatError(error)}`);
            });
        }
    }

    async handleTicketCreateFailed(payload) {
        const pending = this.pendingPings.get(payload.userId);
        if (!pending) return;

        const dmChannel = await this.client.channels.fetch(pending.channelId).catch(() => null);
        if (dmChannel?.isTextBased()) {
            await dmChannel.send(`Modmail ticket creation failed during ${payload.phase || 'an unknown phase'}.\n${payload.error || 'Unknown error'}`).catch(error => {
                console.error(`[MODMAIL-DEBUG] Failed to send ticket creation error to ${payload.userId}: ${formatError(error)}`);
            });
        }
        this.pendingPings.delete(payload.userId);
    }
}

function isDebugUser(userId) {
    const config = getConfig();
    return userId === config.master_id || userId === config.operator_id;
}

function isCommandLike(content) {
    const config = getConfig();
    const text = String(content || '');
    return text.startsWith(config.prefix) || text.startsWith('k!') || text.startsWith('_*');
}

function formatError(error) {
    if (!error) return 'Unknown error';
    if (error.stack) return error.stack;
    if (error.message) return error.message;
    return String(error);
}

module.exports = { ModmailDebugCog };
