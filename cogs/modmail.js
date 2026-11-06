const fs = require('fs');
const path = require('path');
const { getConfig, saveConfig } = require('../config-store');
const { Events, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');

const DATA_FILE = path.join(__dirname, '..', 'data', 'modmail.json');
const TRACE_FILE = path.join(__dirname, '..', 'data', 'modmail-trace.log');
const TRANSCRIPTS_DIR = path.join(__dirname, '..', 'data', 'modmail-transcripts');
const DM_PRIME_INTERVAL_MS = 1_500;
const DM_PRIME_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const DM_PRIME_STARTUP_MEMBER_LIMIT = 2_500;
const MAX_PENDING_DRAFT_MESSAGES = 5;
const MODMAIL_COLORS = {
    info: 0x2b8cbe,
    success: 0x3ba55d,
    warning: 0xfaa61a
};
// Routing lives in config.json under "modmail". Tag ids are Discord forum tag ids.
const modmailConfig = getConfig().modmail || {};
const MODMAIL_GUILD_ID = modmailConfig.guild_id || '';
const MODMAIL_SUPPORT_ROLE_ID = modmailConfig.default_support_role_id || '';
const MODMAIL_CATEGORIES = Object.fromEntries((modmailConfig.categories || []).map(c => [c.id, {
    id: c.id,
    label: c.label,
    forumChannelId: c.forum_channel_id,
    supportRoleId: c.support_role_id || undefined,
    supportUserId: c.support_user_id || undefined,
    ongoingTagId: c.ongoing_tag_id || undefined,
    resolvedTagId: c.resolved_tag_id || undefined,
    tags: (c.tags || []).filter(tag => tag.id)
}]));
const FALLBACK_CATEGORY_ID = MODMAIL_CATEGORIES.other ? 'other' : Object.keys(MODMAIL_CATEGORIES).at(-1);
const CATEGORY_SELECT_OPTIONS = Object.values(MODMAIL_CATEGORIES);

class ModmailCog {
    constructor(client) {
        this.client = client;
        this.state = this.loadState();
        this.started = false;
        this.dmPrimeQueue = [];
        this.dmPrimeQueuedUserIds = new Set();
        this.dmPrimeKnownChannels = new Map();
        this.dmPrimeLastSuccessAt = new Map();
        this.dmPrimeInFlight = false;
        this.dmPrimeLastAttemptAt = 0;
        this.boundHandleMessageCreate = m => void this.handleMessageCreate(m).catch(e => this.logError('MessageCreate', e));
        this.boundHandleMessageUpdate = (b, a) => void this.handleMessageUpdate(b, a).catch(e => this.logError('MessageUpdate', e));
        this.boundHandleMessageDelete = m => void this.handleMessageDelete(m).catch(e => this.logError('MessageDelete', e));
        this.boundHandleThreadDelete = t => void this.handleThreadDelete(t).catch(e => this.logError('ThreadDelete', e));
        this.boundHandleInteraction = i => void this.handleInteraction(i).catch(e => this.logError('InteractionCreate', e));
    }

    logError(label, error) {
        console.error(`[MODMAIL] ${label} handler failed: ${error.message}`);
        appendTrace(`${label.toLowerCase()}_error`, { error: formatError(error) });
    }

    start() {
        if (this.started) return;
        this.client.on(Events.MessageCreate, this.boundHandleMessageCreate);
        this.client.on(Events.MessageUpdate, this.boundHandleMessageUpdate);
        this.client.on(Events.MessageDelete, this.boundHandleMessageDelete);
        this.client.on(Events.ThreadDelete, this.boundHandleThreadDelete);
        this.client.on(Events.InteractionCreate, this.boundHandleInteraction);
        this.started = true;
    }

    stop() {
        if (!this.started) return;
        this.client.off(Events.MessageCreate, this.boundHandleMessageCreate);
        this.client.off(Events.MessageUpdate, this.boundHandleMessageUpdate);
        this.client.off(Events.MessageDelete, this.boundHandleMessageDelete);
        this.client.off(Events.ThreadDelete, this.boundHandleThreadDelete);
        this.client.off(Events.InteractionCreate, this.boundHandleInteraction);
        this.dmPrimeQueue = [];
        this.dmPrimeQueuedUserIds.clear();
        this.dmPrimeKnownChannels.clear();
        this.dmPrimeLastSuccessAt.clear();
        this.dmPrimeInFlight = false;
        this.dmPrimeLastAttemptAt = 0;
        this.started = false;
    }

    markDmPrimed(userId, channelId = null) {
        if (!userId) return;
        this.dmPrimeLastSuccessAt.set(userId, Date.now());
        if (channelId) this.dmPrimeKnownChannels.set(userId, channelId);
    }

    queueDmPrime(userOrId, options = {}) {
        const userId = typeof userOrId === 'string' ? userOrId : userOrId?.id;
        if (!userId) return false;

        const force = options.force === true;
        const priority = options.priority === true;
        const reason = options.reason || 'manual';
        const lastSuccessAt = this.dmPrimeLastSuccessAt.get(userId) || 0;

        if (!force && lastSuccessAt && (Date.now() - lastSuccessAt) < DM_PRIME_COOLDOWN_MS) {
            return false;
        }
        if (this.dmPrimeQueuedUserIds.has(userId)) return false;

        const entry = {
            userId,
            reason,
            force,
            user: typeof userOrId === 'object' && userOrId ? userOrId : null
        };

        if (priority) {
            this.dmPrimeQueue.unshift(entry);
        } else {
            this.dmPrimeQueue.push(entry);
        }
        this.dmPrimeQueuedUserIds.add(userId);
        void this.processDmPrimeQueue();
        return true;
    }

    async processDmPrimeQueue() {
        if (this.dmPrimeInFlight) return;
        this.dmPrimeInFlight = true;

        try {
            while (this.dmPrimeQueue.length) {
                const entry = this.dmPrimeQueue.shift();
                if (!entry) continue;

                this.dmPrimeQueuedUserIds.delete(entry.userId);

                const elapsedMs = Date.now() - this.dmPrimeLastAttemptAt;
                if (elapsedMs < DM_PRIME_INTERVAL_MS) {
                    await wait(DM_PRIME_INTERVAL_MS - elapsedMs);
                }

                this.dmPrimeLastAttemptAt = Date.now();
                await this.performDmPrime(entry);
            }
        } finally {
            this.dmPrimeInFlight = false;
        }
    }

    async performDmPrime(entry) {
        const user = entry.user?.id === entry.userId
            ? entry.user
            : await this.client.users.fetch(entry.userId).catch(() => null);

        if (!user || user.bot) {
            appendTrace('dm_prime_skipped', { userId: entry.userId, reason: entry.reason, skipped: 'user_unavailable' });
            return;
        }

        const dm = await this.getUserDmChannel(user, entry.reason, { traceSuccess: entry.reason !== 'startup_guild_member_sync' });
        if (!dm) {
            appendTrace('dm_prime_failed', { userId: user.id, reason: entry.reason, error: 'createDM returned null' });
        }
    }

    async primeKnownDmChannels() {
        const knownUserIds = new Set([
            ...Object.keys(this.state.userIndex || {}),
            ...Object.values(this.state.tickets || {}).map(ticket => ticket?.userId).filter(Boolean),
            ...this.pendingTickets.keys()
        ]);

        let prioritizedCount = 0;
        for (const userId of knownUserIds) {
            if (this.queueDmPrime(userId, { reason: 'startup_known_ticket_user', force: true, priority: true })) {
                prioritizedCount += 1;
            }
        }

        const guildIdsToPrime = collectStartupPrimeGuildIds(this.client);
        let totalEnqueuedMembers = 0;

        for (const guildId of guildIdsToPrime) {
            const guild = this.client.guilds.cache.get(guildId)
                || await this.client.guilds.fetch(guildId).catch(error => {
                    appendTrace('dm_prime_startup_failed', { phase: 'fetch_guild', guildId, error: formatError(error) });
                    return null;
                });
            if (!guild) continue;

            const memberCountHint = Number.isFinite(guild.memberCount) ? guild.memberCount : null;
            const shouldFetchAllMembers = !memberCountHint || memberCountHint <= DM_PRIME_STARTUP_MEMBER_LIMIT;
            const memberSource = shouldFetchAllMembers
                ? await guild.members.fetch().catch(error => {
                    appendTrace('dm_prime_startup_failed', { phase: 'fetch_members', guildId: guild.id, error: formatError(error) });
                    return null;
                })
                : guild.members.cache;

            if (!memberSource) {
                appendTrace('dm_prime_startup_complete', {
                    guildId: guild.id,
                    prioritizedCount,
                    enqueuedMembers: 0,
                    skippedFullMemberPrime: shouldFetchAllMembers ? false : true,
                    memberCountHint
                });
                continue;
            }

            let enqueuedMembers = 0;
            for (const member of memberSource.values()) {
                if (member.user?.bot) continue;
                if (this.queueDmPrime(member.user, { reason: `startup_guild_member_sync:${guild.id}`, force: true })) {
                    enqueuedMembers += 1;
                }
            }

            totalEnqueuedMembers += enqueuedMembers;
            appendTrace('dm_prime_startup_complete', {
                guildId: guild.id,
                prioritizedCount,
                enqueuedMembers,
                skippedFullMemberPrime: shouldFetchAllMembers ? false : true,
                memberCountHint
            });
        }

        appendTrace('dm_prime_startup_summary', {
            prioritizedCount,
            guildCount: guildIdsToPrime.length,
            totalEnqueuedMembers
        });
    }

    async getUserDmChannel(userOrId, reason = 'unspecified', options = {}) {
        const traceSuccess = options.traceSuccess === true;
        const user = typeof userOrId === 'string'
            ? await this.client.users.fetch(userOrId).catch(() => null)
            : userOrId;

        if (!user || user.bot) return null;

        const dm = await user.createDM().catch(error => {
            appendTrace('dm_channel_open_failed', { userId: user.id, reason, error: formatError(error) });
            return null;
        });
        if (!dm) return null;

        this.markDmPrimed(user.id, dm.id);
        if (traceSuccess) {
            appendTrace('dm_channel_opened', { userId: user.id, channelId: dm.id, reason });
        }
        return dm;
    }

    async createTicketFromSlashCommand(user, categoryId, initialMessage) {
        if (!this.isEnabled()) {
            return { ok: false, reason: 'Modmail is currently disabled.' };
        }

        const openTicket = this.getTicketByUserId(user.id);
        if (openTicket?.open) {
            return { ok: false, reason: 'You already have an open modmail ticket. Keep replying here in DMs if Discord delivers them, or ask staff to continue in your existing ticket.' };
        }

        const cleanedMessage = String(initialMessage || '').trim();
        if (!cleanedMessage) {
            return { ok: false, reason: 'Your initial message cannot be empty.' };
        }

        const normalizedCategoryId = MODMAIL_CATEGORIES[categoryId] ? categoryId : FALLBACK_CATEGORY_ID;
        const selectedTagId = resolveFallbackTagId(normalizedCategoryId);
        const ticket = await this.createTicketFromDrafts({
            user,
            drafts: [{ id: null, content: cleanedMessage, attachments: [] }],
            categoryId: normalizedCategoryId,
            selectedTagId
        });

        if (!ticket) {
            return { ok: false, reason: 'I could not create your modmail ticket right now. Please try again in a moment.' };
        }

        const dm = await this.getUserDmChannel(user, 'slash_modmail_open', { traceSuccess: true });
        if (dm) {
            await dm.send('Your modmail ticket has been created. Staff will reply to you here in DMs. If Discord drops one of your future DMs, you can run `/modmail` again in the server to reach staff.').catch(error => {
                appendTrace('slash_modmail_dm_notice_failed', { userId: user.id, ticketId: ticket.threadId, error: formatError(error) });
            });
        }

        appendTrace('slash_modmail_ticket_created', {
            userId: user.id,
            ticketId: ticket.threadId,
            categoryId: normalizedCategoryId,
            dmNoticeSent: Boolean(dm)
        });
        return { ok: true, ticket, dmReady: Boolean(dm) };
    }

    loadState() {
        ensureJsonFile(DATA_FILE, { version: 3, tickets: {}, userIndex: {}, threadIndex: {}, messageLinks: {}, pendingTickets: {} });
        try {
            const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            this.pendingTickets = new Map(Object.entries(raw.pendingTickets || {}));
            return {
                version: 3,
                tickets: raw.tickets || {},
                userIndex: raw.userIndex || {},
                threadIndex: raw.threadIndex || {},
                messageLinks: raw.messageLinks || {},
                pendingTickets: raw.pendingTickets || {}
            };
        } catch (error) {
            console.error(`[MODMAIL] Failed to load state: ${error.message}`);
            this.pendingTickets = new Map();
            return { version: 3, tickets: {}, userIndex: {}, threadIndex: {}, messageLinks: {}, pendingTickets: {} };
        }
    }

    saveState() {
        this.state.pendingTickets = Object.fromEntries(this.pendingTickets);
        fs.writeFileSync(DATA_FILE, JSON.stringify(this.state, null, 2));
    }
    isEnabled() { return getConfig().toggle_mod_mail !== false; }
    toggleEnabled() { return saveConfig({ ...getConfig(), toggle_mod_mail: !this.isEnabled() }).toggle_mod_mail; }
    useSilentModmailPings() { return getConfig().silent_modmail_pings === true; }
    getTicketByUserId(userId) { const id = this.state.userIndex[userId]; return id ? this.state.tickets[id] || null : null; }
    getTicketByThreadId(threadId) { const id = this.state.threadIndex[threadId]; return id ? this.state.tickets[id] || null : null; }
    upsertTicket(ticket) { this.state.tickets[ticket.threadId] = ticket; this.state.userIndex[ticket.userId] = ticket.threadId; this.state.threadIndex[ticket.threadId] = ticket.threadId; this.saveState(); }
    markTicketClosed(ticket) { ticket.open = false; this.state.tickets[ticket.threadId] = ticket; delete this.state.userIndex[ticket.userId]; delete this.state.threadIndex[ticket.threadId]; this.saveState(); }
    linkMessages(sourceId, counterpartId, ticketId) { this.state.messageLinks[sourceId] = { counterpartId, ticketId }; this.state.messageLinks[counterpartId] = { counterpartId: sourceId, ticketId }; this.saveState(); }
    unlinkMessage(messageId) { const link = this.state.messageLinks[messageId]; if (!link) return; delete this.state.messageLinks[messageId]; delete this.state.messageLinks[link.counterpartId]; this.saveState(); }
    getOrCreatePending(userId) { return this.pendingTickets.get(userId) || { drafts: [], createdAt: Date.now(), updatedAt: Date.now() }; }
    setPendingTicket(userId, pending) { this.pendingTickets.set(userId, pending); this.saveState(); }
    deletePendingTicket(userId) { if (!this.pendingTickets.has(userId)) return; this.pendingTickets.delete(userId); this.saveState(); }

    async handleMessageCreate(message) {
        const liveMessage = message.partial ? await message.fetch().catch(() => message) : message;

        if (!liveMessage.guild) {
            if (liveMessage.author.id === this.client.user?.id) return;
            return this.handleDirectMessage(liveMessage);
        }
        if (liveMessage.author.bot) return;
        if (liveMessage.guild.id !== MODMAIL_GUILD_ID || !liveMessage.channel.isThread()) return;
        await this.handleStaffThreadMessage(liveMessage);
    }

    async handleDirectMessage(message) {
        if (message.author.bot) return;
        const previousPrimeAt = this.dmPrimeLastSuccessAt.get(message.author.id) || 0;
        const recentlyPrimed = previousPrimeAt ? (Date.now() - previousPrimeAt) < DM_PRIME_COOLDOWN_MS : false;
        this.markDmPrimed(message.author.id, message.channel?.id || null);
        appendTrace('dm_received', {
            userId: message.author.id,
            channelId: message.channel.id,
            messageId: message.id,
            hasContent: Boolean(message.content),
            attachmentCount: message.attachments.size,
            messagePartial: Boolean(message.partial),
            channelPartial: Boolean(message.channel?.partial),
            channelType: message.channel?.type ?? null,
            channelCached: Boolean(message.channel?.id && this.client.channels.cache.has(message.channel.id)),
            userCached: this.client.users.cache.has(message.author.id), 
        });
        if (!this.isEnabled()) return void await message.channel.send('Modmail is currently disabled. Please try again later.').catch(() => {});
        const openTicket = this.getTicketByUserId(message.author.id);
        if (isMasterDmCloseCommand(message)) {
            if (!openTicket?.open) return void await message.channel.send('You do not have an open modmail ticket to close.').catch(() => {});
            const liveThread = await this.resolveLiveThread(openTicket);
            if (!liveThread) { this.markTicketClosed(openTicket); return void await message.channel.send('I could not find the active modmail thread for this ticket.').catch(() => {}); }
            return void await this.closeTicket(openTicket, liveThread, false, message.author);
        }
        if (isCommandLikeDm(message.content)) return;
        if (openTicket?.open) {
            const liveThread = await this.resolveLiveThread(openTicket);
            if (liveThread) return void await this.forwardDmToThread(openTicket, liveThread, message);
            this.markTicketClosed(openTicket);
            const recreated = await this.createTicketFromDrafts({ user: message.author, drafts: [serializeMessage(message)], categoryId: openTicket.categoryId || FALLBACK_CATEGORY_ID, selectedTagId: openTicket.selectedTagId || resolveFallbackTagId(openTicket.categoryId || FALLBACK_CATEGORY_ID) });
            if (recreated) await message.channel.send('Your previous thread was unavailable, so I opened a replacement ticket for you.').catch(() => {});
            return;
        }
        const pendingControl = parsePendingControlKeyword(message.content);
        if (pendingControl && message.attachments.size === 0) {
            return void await this.handlePendingControlKeyword(message, pendingControl);
        }
        const pending = this.getOrCreatePending(message.author.id);
        if ((pending.drafts?.length || 0) >= MAX_PENDING_DRAFT_MESSAGES) {
            pending.updatedAt = Date.now();
            this.setPendingTicket(message.author.id, pending);
            appendTrace('pending_draft_limit_hit', {
                userId: message.author.id,
                channelId: message.channel.id,
                limit: MAX_PENDING_DRAFT_MESSAGES
            });
            await message.channel.send({
                embeds: [buildTicketStatusEmbed(
                    'Message cache limit reached',
                    `Cached ${MAX_PENDING_DRAFT_MESSAGES} of 5 maximum messages for this ticket. Please select a category to continue, or send \`clear\` to start over.`,
                    MODMAIL_COLORS.warning
                )]
            }).catch(() => {});
            const resent = await this.sendCategoryMenu(message.author, message.channel, pending, { forceResend: true });
            if (!resent) appendTrace('category_menu_send_failed', { userId: message.author.id, channelId: message.channel.id });
            return;
        }
        pending.drafts.push(serializeMessage(message));
        pending.updatedAt = Date.now();
        this.setPendingTicket(message.author.id, pending);
        const sent = await this.sendCategoryMenu(message.author, message.channel, pending, { forceResend: pending.drafts.length > 1 });
        if (!sent) appendTrace('category_menu_send_failed', { userId: message.author.id, channelId: message.channel.id });
    }

    async handlePendingControlKeyword(message, action) {
        const pending = this.pendingTickets.get(message.author.id);
        const hasPending = Boolean(pending && ((pending.drafts?.length || 0) > 0 || pending.menuMessageId || pending.creating));

        if (pending?.creating) {
            await message.channel.send({ embeds: [buildTicketStatusEmbed('Please Wait', 'Your ticket is already being created. Please wait a moment for the result.', MODMAIL_COLORS.warning)] }).catch(() => {});
            return;
        }

        if (action === 'resend') {
            if (!hasPending) {
                await message.channel.send({ embeds: [buildTicketStatusEmbed('No Pending Modmail', 'There is no pending modmail flow to resend. Send your message and I will start one.', MODMAIL_COLORS.warning)] }).catch(() => {});
                return;
            }
            pending.updatedAt = Date.now();
            this.setPendingTicket(message.author.id, pending);
            const sent = await this.sendCategoryMenu(message.author, message.channel, pending, { forceResend: true });
            if (!sent) {
                await message.channel.send({ embeds: [buildTicketStatusEmbed('Resend Failed', 'I could not resend the menu right now. Please try again in a moment.', MODMAIL_COLORS.warning)] }).catch(() => {});
                return;
            }
            appendTrace('pending_control_resend', { userId: message.author.id, channelId: message.channel.id });
            return;
        }

        if (!hasPending) {
            await message.channel.send({ embeds: [buildTicketStatusEmbed('No Pending Modmail', 'There is no pending modmail flow to control right now.', MODMAIL_COLORS.warning)] }).catch(() => {});
            return;
        }

        this.deletePendingTicket(message.author.id);
        if (action === 'clear') {
            appendTrace('pending_control_clear', { userId: message.author.id, channelId: message.channel.id });
            await message.channel.send({ embeds: [buildTicketStatusEmbed('Modmail Cleared', 'I cleared your pending modmail flow. Send a new message whenever you want to start over.', MODMAIL_COLORS.success)] }).catch(() => {});
            return;
        }

        appendTrace('pending_control_abort', { userId: message.author.id, channelId: message.channel.id });
        await message.channel.send({ embeds: [buildTicketStatusEmbed('Cancelled', 'Cancelled your pending modmail flow. Send a new message if you want to start a new ticket.', MODMAIL_COLORS.success)] }).catch(() => {});
    }

    async handleStaffThreadMessage(message) {
        if (!this.isEnabled() || message.system || message.content.startsWith(getConfig().prefix)) return;
        const ticket = this.getTicketByThreadId(message.channel.id);
        if (!ticket?.open) return;
        const user = await this.client.users.fetch(ticket.userId).catch(() => null);
        if (!user) return;
        const replyToMessageId = this.resolveMirroredReplyMessageId(message, ticket.threadId);
        const dmPayload = { content: buildStaffRelay(message) };
        if (replyToMessageId) dmPayload.reply = { messageReference: replyToMessageId, failIfNotExists: false };
        const mirrored = await user.send(dmPayload).catch(error => { appendTrace('staff_dm_failed', { userId: ticket.userId, ticketId: ticket.threadId, error: formatError(error) }); return null; });
        if (mirrored) {
            this.markDmPrimed(ticket.userId, mirrored.channelId || mirrored.channel?.id || null);
            this.linkMessages(message.id, mirrored.id, ticket.threadId);
        }
    }

    async handleMessageUpdate(before, after) {
        const source = after.partial ? await after.fetch().catch(() => null) : after;
        if (!source || source.author?.bot) return;
        const link = this.state.messageLinks[source.id], ticket = link && this.state.tickets[link.ticketId];
        if (!ticket) return;
        if (!source.guild) {
            const thread = await this.resolveLiveThread(ticket);
            const counterpart = thread?.isTextBased() ? await thread.messages.fetch(link.counterpartId).catch(() => null) : null;
            if (!counterpart) return void this.unlinkMessage(source.id);
            return void await counterpart.edit({ content: buildUserRelay(source, true) }).catch(() => {});
        }
        const user = await this.client.users.fetch(ticket.userId).catch(() => null);
        const dm = user ? await this.getUserDmChannel(user, 'message_update_counterpart_lookup') : null;
        const counterpart = dm ? await dm.messages.fetch(link.counterpartId).catch(() => null) : null;
        if (!counterpart) return void this.unlinkMessage(source.id);
        await counterpart.edit({ content: buildStaffRelay(source, true) }).catch(() => {});
    }

    async handleMessageDelete(message) {
        const link = this.state.messageLinks[message.id], ticket = link && this.state.tickets[link.ticketId];
        if (!ticket) return void (link && this.unlinkMessage(message.id));
        if (!message.guild) {
            const thread = await this.resolveLiveThread(ticket);
            const counterpart = thread?.isTextBased() ? await thread.messages.fetch(link.counterpartId).catch(() => null) : null;
            if (counterpart) await counterpart.delete().catch(() => {});
            return void this.unlinkMessage(message.id);
        }
        const user = await this.client.users.fetch(ticket.userId).catch(() => null);
        const dm = user ? await this.getUserDmChannel(user, 'message_delete_counterpart_lookup') : null;
        const counterpart = dm ? await dm.messages.fetch(link.counterpartId).catch(() => null) : null;
        if (counterpart) await counterpart.delete().catch(() => {});
        this.unlinkMessage(message.id);
    }

    resolveMirroredReplyMessageId(sourceMessage, ticketId) {
        const referenceId = sourceMessage?.reference?.messageId;
        if (!referenceId) return null;
        const link = this.state.messageLinks[referenceId];
        if (!link || link.ticketId !== ticketId) return null;
        return link.counterpartId || null;
    }

    async handleThreadDelete(thread) {
        const ticket = this.getTicketByThreadId(thread.id);
        if (ticket) this.markTicketClosed(ticket);
    }

    async handleInteraction(interaction) {
        if (interaction.isButton() && (interaction.customId === 'modmail_close_ticket' || interaction.customId === 'modmail_resolve_ticket')) {
            if (!interaction.guildId || interaction.guildId !== MODMAIL_GUILD_ID || !interaction.channel?.isThread()) return;
            const ticket = this.getTicketByThreadId(interaction.channel.id);
            if (!ticket?.open) return void await replyToInteraction(interaction, { content: 'This ticket is already closed.', ephemeral: true });
            const resolved = interaction.customId === 'modmail_resolve_ticket';
            await this.closeTicket(ticket, interaction.channel, resolved, interaction.user);
            return void await replyToInteraction(interaction, { content: resolved ? 'Ticket resolved and archived.' : 'Ticket closed and archived.', ephemeral: true });
        }
        if (interaction.isStringSelectMenu() && interaction.customId === 'modmail_category_select') {
            if (!this.isEnabled()) return void await replyToInteraction(interaction, { content: 'Modmail is currently disabled.' });
            const openTicket = this.getTicketByUserId(interaction.user.id);
            if (openTicket?.open) return void await interaction.update({ embeds: [buildTicketStatusEmbed('Ticket Already Open', 'You already have an open modmail ticket. Keep replying here in DMs and I will relay your messages to staff.', MODMAIL_COLORS.warning)], components: [] }).catch(() => {});
            const pending = this.pendingTickets.get(interaction.user.id);
            if (!pending?.drafts?.length) return void await interaction.update({ embeds: [buildTicketStatusEmbed('Menu Expired', 'Your previous menu expired. Send me a new DM and I will send a fresh category menu.', MODMAIL_COLORS.warning)], components: [] }).catch(() => {});
            const categoryId = interaction.values[0], category = MODMAIL_CATEGORIES[categoryId];
            if (!category) return void await interaction.update({ embeds: [buildTicketStatusEmbed('Category Unavailable', 'That category is not available right now. Send me a new DM to try again.', MODMAIL_COLORS.warning)], components: [] }).catch(() => {});
            pending.categoryId = categoryId; pending.updatedAt = Date.now(); this.setPendingTicket(interaction.user.id, pending);
            if ((category.tags || []).length <= 1) return void await this.createTicketFromPending({ interaction, user: interaction.user, pending, categoryId, selectedTagId: category.tags?.[0]?.id });
            return void await interaction.update({
                embeds: [buildTicketStatusEmbed('Category Selected', `You selected **${category.label}**.\nPick the tag that best matches your ticket.`, MODMAIL_COLORS.info)],
                components: [buildTagRow(categoryId)]
            }).catch(() => {});
        }
        if (interaction.isStringSelectMenu() && interaction.customId.startsWith('modmail_tag_select:')) {
            if (!this.isEnabled()) return void await replyToInteraction(interaction, { content: 'Modmail is currently disabled.' });
            const openTicket = this.getTicketByUserId(interaction.user.id);
            if (openTicket?.open) return void await interaction.update({ embeds: [buildTicketStatusEmbed('Ticket Already Open', 'You already have an open modmail ticket. Keep replying here in DMs and I will relay your messages to staff.', MODMAIL_COLORS.warning)], components: [] }).catch(() => {});
            const pending = this.pendingTickets.get(interaction.user.id);
            if (!pending?.drafts?.length) return void await interaction.update({ embeds: [buildTicketStatusEmbed('Menu Expired', 'Your previous menu expired. Send me a new DM and I will send a fresh category menu.', MODMAIL_COLORS.warning)], components: [] }).catch(() => {});
            const categoryId = interaction.customId.split(':')[1];
            await this.createTicketFromPending({ interaction, user: interaction.user, pending, categoryId, selectedTagId: interaction.values[0] });
        }
    }

    async sendCategoryMenu(user, channel, pending, options = {}) {
        const forceResend = options.forceResend === true;
        if (pending.menuMessageId && !forceResend) return true;
        if (forceResend) pending.menuMessageId = null;
        const menu = await channel.send({
            embeds: [buildCategoryMenuEmbed(pending, forceResend)],
            components: [buildCategoryRow()]
        }).catch(error => { this.emitDebugEvent('launcherFailed', { userId: user.id, channelId: channel.id, error: formatError(error) }); return null; });
        if (!menu) return false;
        pending.menuMessageId = menu.id; pending.menuSentAt = Date.now(); this.setPendingTicket(user.id, pending);
        this.emitDebugEvent('launcherSent', { userId: user.id, channelId: channel.id, launcherMessageId: menu.id });
        appendTrace('category_menu_sent', { userId: user.id, channelId: channel.id, menuMessageId: menu.id });
        return true;
    }

    async createTicketFromPending({ interaction, user, pending, categoryId, selectedTagId }) {
        if (pending.creating) return;
        await safeInteractionDefer(interaction);
        pending.creating = true; this.setPendingTicket(user.id, pending);
        const ticket = await this.createTicketFromDrafts({ user, drafts: pending.drafts, categoryId, selectedTagId });
        if (!ticket) {
            pending.creating = false; this.setPendingTicket(user.id, pending);
            return void await safeInteractionUpdate(interaction, { embeds: [buildTicketStatusEmbed('Ticket Creation Failed', 'I received your message, but I could not create the modmail ticket right now. Please try again in a moment.', MODMAIL_COLORS.warning)], components: [] });
        }
        this.deletePendingTicket(user.id);
        await safeInteractionUpdate(interaction, { embeds: [buildTicketStatusEmbed('Ticket Created', 'Your ticket has been created. Staff will reply to you here in DMs.', MODMAIL_COLORS.success)], components: [] });
    }

    async createTicketFromDrafts({ user, drafts, categoryId, selectedTagId }) {
        const category = MODMAIL_CATEGORIES[categoryId], selectedTag = category?.tags.find(tag => tag.id === selectedTagId);
        if (!category) { this.emitDebugEvent('ticketCreateFailed', { userId: user.id, phase: 'category', error: `Unknown category ${categoryId}` }); return null; }
        if (!selectedTag) { this.emitDebugEvent('ticketCreateFailed', { userId: user.id, phase: 'tag', error: `Unknown tag ${selectedTagId}` }); return null; }
        const forumChannel = await this.client.channels.fetch(category.forumChannelId).catch(error => { this.emitDebugEvent('ticketCreateFailed', { userId: user.id, phase: 'fetch_forum', error: formatError(error) }); return null; });
        if (!forumChannel || forumChannel.type !== ChannelType.GuildForum || forumChannel.guildId !== MODMAIL_GUILD_ID) {
            this.emitDebugEvent('ticketCreateFailed', { userId: user.id, phase: 'validate_forum', error: `Forum ${category.forumChannelId} unavailable` });
            return null;
        }
        const pending = synthesizePending(user, drafts);
        let thread;
        try {
            const appliedTags = []; if (category.ongoingTagId) appliedTags.push(category.ongoingTagId); appliedTags.push(selectedTagId);
            thread = await forumChannel.threads.create({
                name: buildThreadName(user, pending.title),
                appliedTags,
                autoArchiveDuration: 10080,
                message: { content: buildOpeningPost(user, pending, selectedTag, category) }
            });
        } catch (error) {
            this.emitDebugEvent('ticketCreateFailed', { userId: user.id, phase: 'create_thread', error: formatError(error) });
            return null;
        }
        const ticket = { guildId: MODMAIL_GUILD_ID, forumChannelId: category.forumChannelId, userId: user.id, threadId: thread.id, threadName: thread.name, title: pending.title, description: pending.description, categoryId, selectedTagId, open: true, createdAt: Date.now() };
        this.upsertTicket(ticket);
        await this.sendTicketNotification(thread, user, category);
        await this.forwardDrafts(thread, ticket, drafts);
        appendTrace('ticket_created', { userId: user.id, ticketId: ticket.threadId, categoryId, selectedTagId });
        return ticket;
    }

    async sendTicketNotification(thread, user, category) {
        const target = getNotificationTarget(category);
        const message = {
            content: `${target.mention} Ticket opened by <@${user.id}>.`,
            embeds: [buildTicketOpenedEmbed(user, category)],
            components: [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('modmail_resolve_ticket').setLabel('Resolve').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('modmail_close_ticket').setLabel('Close').setStyle(ButtonStyle.Danger)
            )],
            allowedMentions: { roles: target.type === 'role' ? [target.id] : [], users: target.type === 'user' ? [target.id, user.id] : [user.id] }
        };
        if (this.useSilentModmailPings()) message.flags = MessageFlags.SuppressNotifications;
        await thread.send(message).catch(error => appendTrace('notification_failed', { threadId: thread.id, userId: user.id, error: formatError(error) }));
    }

    async forwardDrafts(thread, ticket, drafts) {
        for (const draft of drafts) {
            const mirrored = await thread.send({ content: buildSerializedRelay(draft) }).catch(error => { appendTrace('draft_forward_failed', { ticketId: ticket.threadId, sourceMessageId: draft.id, error: formatError(error) }); return null; });
            if (mirrored && draft.id) this.linkMessages(draft.id, mirrored.id, ticket.threadId);
        }
    }

    async resolveLiveThread(ticket) {
        const thread = await this.client.channels.fetch(ticket.threadId).catch(() => null);
        return thread?.isThread() && thread.guildId === MODMAIL_GUILD_ID ? thread : null;
    }

    async forwardDmToThread(ticket, thread, message) {
        const replyToMessageId = this.resolveMirroredReplyMessageId(message, ticket.threadId);
        const threadPayload = { content: buildUserRelay(message) };
        if (replyToMessageId) threadPayload.reply = { messageReference: replyToMessageId, failIfNotExists: false };
        const mirrored = await thread.send(threadPayload).catch(error => { appendTrace('dm_forward_failed', { userId: message.author.id, ticketId: ticket.threadId, error: formatError(error) }); return null; });
        if (mirrored) return void this.linkMessages(message.id, mirrored.id, ticket.threadId);
        this.markTicketClosed(ticket);
        const recreated = await this.createTicketFromDrafts({ user: message.author, drafts: [serializeMessage(message)], categoryId: ticket.categoryId || FALLBACK_CATEGORY_ID, selectedTagId: ticket.selectedTagId || resolveFallbackTagId(ticket.categoryId || FALLBACK_CATEGORY_ID) });
        if (recreated) await message.channel.send('I had to reopen your modmail ticket because the previous thread was unavailable.').catch(() => {});
    }

    async sendStaffCommandReply(ticket, thread, author, content, options = {}) {
        const cleaned = String(content || '').trim();
        if (!cleaned) return { ok: false, reason: 'Reply content cannot be empty.' };

        const user = await this.client.users.fetch(ticket.userId).catch(() => null);
        if (!user) return { ok: false, reason: 'I could not resolve the ticket recipient.' };

        const dmMessage = await user.send({ content: buildCommandReplyDm(cleaned, options) }).catch(error => {
            appendTrace('command_reply_dm_failed', { ticketId: ticket.threadId, userId: ticket.userId, authorId: author.id, error: formatError(error) });
            return null;
        });
        if (!dmMessage) return { ok: false, reason: 'Failed to send the DM reply to the user.' };
        this.markDmPrimed(ticket.userId, dmMessage.channelId || dmMessage.channel?.id || null);

        const threadMessage = await thread.send({ content: buildCommandReplyThread(cleaned, author, options) }).catch(error => {
            appendTrace('command_reply_thread_failed', { ticketId: ticket.threadId, userId: ticket.userId, authorId: author.id, error: formatError(error) });
            return null;
        });
        if (threadMessage) {
            this.linkMessages(threadMessage.id, dmMessage.id, ticket.threadId);
        }

        return { ok: true };
    }

    async addInternalNote(ticket, thread, author, content) {
        const cleaned = String(content || '').trim();
        if (!cleaned) return { ok: false, reason: 'Note content cannot be empty.' };
        const noteMessage = await thread.send({ content: buildInternalNote(cleaned, author) }).catch(error => {
            appendTrace('note_send_failed', { ticketId: ticket.threadId, authorId: author.id, error: formatError(error) });
            return null;
        });
        return noteMessage ? { ok: true } : { ok: false, reason: 'Failed to post the internal note.' };
    }

    emitDebugEvent(eventName, payload = {}) {
        appendTrace(`event_${eventName}`, payload);
        this.client.emit(`modmail:${eventName}`, { timestamp: Date.now(), ...payload });
    }

    async closeTicket(ticket, thread, resolved, closer = null) {
        const closerText = formatCloser(closer);
        const transcriptPath = await this.writeTranscript(thread, ticket, { resolved, closerText });
        ticket.closedAt = Date.now();
        ticket.closedById = closer?.id || null;
        ticket.closedByTag = closer?.tag || closer?.username || null;
        ticket.closedReason = resolved ? 'resolved' : 'closed';
        ticket.transcriptPath = transcriptPath;
        this.markTicketClosed(ticket);
        const category = MODMAIL_CATEGORIES[ticket.categoryId], ongoing = category?.ongoingTagId, done = category?.resolvedTagId;
        const nextTags = Array.isArray(thread.appliedTags) ? thread.appliedTags.filter(id => id !== ongoing && id !== done) : [];
        if (resolved && done) nextTags.push(done);
        await thread.setAppliedTags(nextTags).catch(() => {});
        const closeSummaryMessage = buildCloseSummaryMessage(ticket, resolved, closerText, transcriptPath);
        await thread.send(closeSummaryMessage).catch(() => {});
        await thread.setLocked(true).catch(() => {});
        await thread.setArchived(true).catch(() => {});
        const user = await this.client.users.fetch(ticket.userId).catch(() => null);
        if (user) await user.send(buildUserCloseMessage(resolved)).catch(() => {});
    }

    async writeTranscript(thread, ticket, metadata) {
        try {
            fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
            const messages = await fetchAllMessages(thread);
            const transcriptLines = buildTranscriptLines(messages, ticket, metadata);
            const filename = `${ticket.threadId}-${Date.now()}.md`;
            const transcriptPath = path.join(TRANSCRIPTS_DIR, filename);
            fs.writeFileSync(transcriptPath, transcriptLines.join('\n'), 'utf8');
            appendTrace('transcript_written', { ticketId: ticket.threadId, transcriptPath });
            return transcriptPath;
        } catch (error) {
            appendTrace('transcript_write_failed', { ticketId: ticket.threadId, error: formatError(error) });
            return null;
        }
    }
}

function buildCategoryRow() {
    return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('modmail_category_select').setPlaceholder('Choose the category for your ticket').setMinValues(1).setMaxValues(1).addOptions(CATEGORY_SELECT_OPTIONS.map(c => new StringSelectMenuOptionBuilder().setLabel(c.label).setValue(c.id).setDescription(`Open a ${c.label} modmail ticket`))));
}

function buildTagRow(categoryId) {
    const options = MODMAIL_CATEGORIES[categoryId]?.tags || [];
    return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`modmail_tag_select:${categoryId}`).setPlaceholder('Choose the tag that best fits your ticket').setMinValues(1).setMaxValues(1).addOptions(options.map(t => new StringSelectMenuOptionBuilder().setLabel(t.label).setValue(t.id).setDescription(t.description))));
}

function buildCategoryMenuEmbed(pending, isResent = false) {
    const draftCount = pending?.drafts?.length || 0;
    const messageNoun = draftCount === 1 ? 'message' : 'messages';
    return new EmbedBuilder()
        .setColor(MODMAIL_COLORS.info)
        .setTitle(isResent ? 'Modmail Category Menu' : 'Welcome To Modmail')
        .setDescription('Please select the category that best fits your ticket so it can be routed to the right team')
        .addFields({ name: 'Cached messages:', value: `Cached ${draftCount} ${messageNoun} of max ${MAX_PENDING_DRAFT_MESSAGES} before ticket creation.` })
        .addFields({ name: 'Controls:', value: 'clear/reset [clear cache], abort/cancel/stop [cancel ticket], resend/menu [resend modmail menu].`' })
        .setFooter({ text: 'why discord, why can I not skip a footer... WHY??? qwq' })
        .setTimestamp(new Date());
}

function buildTicketStatusEmbed(title, description, color = MODMAIL_COLORS.info) {
    return new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(description)
        .setTimestamp(new Date());
}

function buildTicketOpenedEmbed(user, category) {
    return new EmbedBuilder()
        .setColor(MODMAIL_COLORS.info)
        .setTitle('New Modmail Ticket')
        .setDescription(`Opened by <@${user.id}>`)
        .addFields(
            { name: 'User', value: `${user.tag} (\`${user.id}\`)`, inline: false },
            { name: 'Category', value: category?.label || 'Unspecified', inline: true }
        )
        .setTimestamp(new Date());
}

function synthesizePending(user, drafts) {
    const primary = drafts.map(d => String(d.content || '').trim()).find(Boolean);
    const title = ((primary || `Ticket from ${user.username}`).replace(/\s+/g, ' ').trim().slice(0, 100)) || `Ticket from ${user.username}`.slice(0, 100);
    const description = drafts.map((d, i) => {
        const content = String(d.content || '').trim(), attachments = d.attachments?.length ? `Attachments: ${d.attachments.join(', ')}` : '';
        const body = [content, attachments].filter(Boolean).join('\n');
        return body ? `Message ${i + 1}:\n${body}` : '';
    }).filter(Boolean).join('\n\n').slice(0, 1500) || 'Ticket opened from DM with no text content.';
    return { title, description };
}

function buildThreadName(user, title) {
    const username = String(user?.username || 'user').replace(/\s+/g, ' ').trim();
    const topic = String(title || 'modmail ticket').replace(/\s+/g, ' ').trim();
    const combined = `${username} - ${topic}`.trim();
    return (combined || `ticket-${user?.id || 'unknown'}`).slice(0, 100);
}

function buildOpeningPost(user, pending, tag, category) {
    return [
        `Opened by: ${user.tag} (\`${user.id}\`)`,
        `User mention: <@${user.id}>`,
        `Category: ${category?.label || 'Unspecified'}`,
        `Tag: ${tag?.label || 'Unspecified'}`,
        `Title: ${pending.title}`,
        '',
        pending.description
    ].join('\n');
}

function buildSerializedRelay(draft) {
    const attachments = draft.attachments?.length ? `\n**Attachments:**\n${draft.attachments.join('\n')}` : '';
    return ['**User:**', draft.content || '*No text content*', attachments].join('\n');
}

function buildUserRelay(message, edited = false) {
    const attachments = message.attachments.size ? `\n**Attachments:**\n${Array.from(message.attachments.values()).map(a => a.url).join('\n')}` : '';
    return [edited ? '**User (edited):**' : '**User:**', message.content || '*No text content*', attachments].join('\n');
}

function buildStaffRelay(message, edited = false) {
    const attachments = message.attachments.size ? `\nAttachments:\n${Array.from(message.attachments.values()).map(a => a.url).join('\n')}` : '';
    return [edited ? '**Staff (edited):**' : '**Staff:**', message.content || '*No text content*', attachments].join('\n');
}

function buildCommandReplyDm(content) {
    return ['**Staff:**', content].join('\n');
}

function buildCommandReplyThread(content, author, options = {}) {
    const label = options.anonymous ? '**Anonymous Reply:**' : `**Staff Reply by <@${author.id}>:**`;
    return [label, content].join('\n');
}

function buildInternalNote(content, author) {
    return [`**Staff Note by <@${author.id}>:**`, content].join('\n');
}

function getNotificationTarget(category) {
    if (category?.supportUserId) return { type: 'user', id: category.supportUserId, mention: `<@${category.supportUserId}>` };
    const roleId = category?.supportRoleId || MODMAIL_SUPPORT_ROLE_ID;
    return { type: 'role', id: roleId, mention: `<@&${roleId}>` };
}

function resolveFallbackTagId(categoryId) {
    const category = MODMAIL_CATEGORIES[categoryId];
    if (!category?.tags?.length) return null;
    return category.tags.find(tag => /other/i.test(tag.label))?.id || category.tags[0].id;
}

function buildCloseSummaryMessage(ticket, resolved, closerText, transcriptPath) {
    const closedAtMs = ticket.closedAt || Date.now();
    const closedAtUnix = Math.floor(closedAtMs / 1000);
    const transcriptFileName = transcriptPath ? path.basename(transcriptPath) : null;
    const lines = [
        resolved ? '## Ticket Resolved' : '## Ticket Closed',
        `- **Closer:** ${closerText}`,
        `- **Closed At:** <t:${closedAtUnix}:F> (<t:${closedAtUnix}:R>)`,
        transcriptFileName ? `- **Transcript:** [Download \`${transcriptFileName}\`](attachment://${transcriptFileName})` : '- **Transcript:** Not available'
    ];
    const payload = { content: lines.join('\n') };
    if (transcriptPath && fs.existsSync(transcriptPath)) {
        payload.files = [new AttachmentBuilder(transcriptPath, { name: transcriptFileName })];
    }
    return payload;
}

function buildUserCloseMessage(resolved) {
    return resolved
        ? 'Your modmail ticket has been marked as resolved and archived.'
        : 'Your modmail ticket has been closed and archived.';
}

function formatCloser(closer) {
    if (!closer) return 'Unknown';
    if (closer.id && closer.tag) return `<@${closer.id}> (\`${closer.tag}\`, \`${closer.id}\`)`;
    if (closer.id) return `<@${closer.id}> (\`${closer.id}\`)`;
    return String(closer);
}

async function fetchAllMessages(thread) {
    const collected = [];
    let before;
    while (true) {
        const batch = await thread.messages.fetch({ limit: 100, before }).catch(() => null);
        if (!batch?.size) break;
        collected.push(...batch.values());
        before = batch.last().id;
        if (batch.size < 100) break;
    }
    return collected.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

function buildTranscriptLines(messages, ticket, metadata) {
    const header = [
        '# Modmail Transcript',
        `Ticket ID: ${ticket.threadId}`,
        `User ID: ${ticket.userId}`,
        `Category: ${ticket.categoryId || 'unknown'}`,
        `Tag: ${ticket.selectedTagId || 'unknown'}`,
        `Closed as: ${metadata?.resolved ? 'resolved' : 'closed'}`,
        `Closer: ${metadata?.closerText || 'Unknown'}`,
        `Generated: ${new Date().toISOString()}`,
        ''
    ];
    const body = messages.flatMap(message => {
        const authorName = message.author?.tag || message.author?.username || message.author?.id || 'Unknown';
        const lines = [`[${new Date(message.createdTimestamp).toISOString()}] ${authorName}:`];
        if (message.content) lines.push(message.content);
        if (message.attachments?.size) {
            lines.push('Attachments:');
            for (const attachment of message.attachments.values()) lines.push(`- ${attachment.url}`);
        }
        if (message.embeds?.length) {
            for (const embed of message.embeds) {
                const embedSummary = [embed.title, embed.description].filter(Boolean).join(' - ');
                if (embedSummary) lines.push(`Embed: ${embedSummary}`);
            }
        }
        lines.push('');
        return lines;
    });
    return [...header, ...body];
}

function isMasterDmCloseCommand(message) { const config = getConfig(); return !message.guild && message.author.id === config.master_id && message.content.trim().toLowerCase() === '_*close'; }
function isCommandLikeDm(content) { const config = getConfig(); const text = String(content || '').trim(); return text.startsWith(config.prefix) || text.startsWith('k!') || text.startsWith('_*'); }
function parsePendingControlKeyword(content) {
    const text = String(content || '').trim().toLowerCase().replace(/[.!?]+$/g, '').replace(/\s+/g, ' ');
    if (!text) return null;
    if (/^\/?(clear|reset|restart)(?:\s+(modmail|ticket|flow))?$/.test(text)) return 'clear';
    if (/^\/?(abort|cancel|stop|quit|end)(?:\s+(modmail|ticket|flow))?$/.test(text)) return 'abort';
    if (/^\/?(resend|menu|retry)(?:\s+(menu|modmail|ticket|flow))?$/.test(text)) return 'resend';
    return null;
}
function ensureJsonFile(filePath, fallbackValue) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, JSON.stringify(fallbackValue, null, 2)); }
function serializeMessage(message) { return { id: message.id, content: message.content || '', attachments: Array.from(message.attachments.values()).map(a => a.url) }; }
function appendTrace(eventName, payload = {}) { try { fs.mkdirSync(path.dirname(TRACE_FILE), { recursive: true }); fs.appendFileSync(TRACE_FILE, `${JSON.stringify({ timestamp: new Date().toISOString(), event: eventName, ...payload })}\n`); } catch (error) { console.error(`[MODMAIL] Failed to write trace log: ${error.message}`); } }
function formatError(error) { if (!error) return 'Unknown error'; if (error.stack) return error.stack; if (error.message) return error.message; return String(error); }
function collectStartupPrimeGuildIds(client) {
    const config = getConfig();
    const priorityGuildIds = [
        config.operator_guild_id,
        config.test_guild_id,
        MODMAIL_GUILD_ID
    ].filter(Boolean);
    const guildIds = [];
    const seen = new Set();

    for (const guildId of priorityGuildIds) {
        if (seen.has(guildId)) continue;
        seen.add(guildId);
        guildIds.push(guildId);
    }

    for (const guild of client.guilds.cache.values()) {
        if (seen.has(guild.id)) continue;
        seen.add(guild.id);
        guildIds.push(guild.id);
    }

    return guildIds;
}
async function replyToInteraction(interaction, payload) { const safe = interaction.guildId ? payload : { ...payload }; if (!interaction.guildId) delete safe.ephemeral; if (interaction.replied || interaction.deferred) return interaction.followUp(safe).catch(() => {}); return interaction.reply(safe).catch(() => {}); }
async function safeInteractionDefer(interaction) {
    if (!interaction || interaction.replied || interaction.deferred) return;
    if (typeof interaction.deferUpdate === 'function') {
        await interaction.deferUpdate().catch(() => {});
        return;
    }
    if (typeof interaction.deferReply === 'function') {
        await interaction.deferReply().catch(() => {});
    }
}
async function safeInteractionUpdate(interaction, payloadOrContent, components = []) {
    const payload = typeof payloadOrContent === 'string'
        ? { content: payloadOrContent, components }
        : { ...payloadOrContent };
    if (!Object.prototype.hasOwnProperty.call(payload, 'components')) payload.components = components;
    if (interaction.replied || interaction.deferred) return interaction.followUp(payload).catch(() => {});
    return interaction.update(payload).catch(async () => interaction.reply(payload).catch(() => {}));
}
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

module.exports = { ModmailCog, MODMAIL_CATEGORIES };
