import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import ollama from 'ollama';
import { MongoClient } from 'mongodb';
import process from 'process';
import chunkText from './chunk-text.js'; // Assuming this is your existing text chunking utility

class CodexBot {
    constructor() {
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.DirectMessages,
                GatewayIntentBits.MessageContent,
            ],
            partials: [Partials.Channel]
        });

        this.token = process.env.DISCORD_BOT_TOKEN;
        this.mongoUri = process.env.MONGODB_URI;
        this.debounceTime = 10000; // 10-second debounce
        this.messageCache = new Map();
        this.lastProcessed = new Map();
        this.mongoClient = new MongoClient(this.mongoUri);

        this.avatar = {
            emoji: '💻',
            name: 'Codex',
            owner: "chrypnotoad",
            avatar: "https://i.imgur.com/yr1UxZw.png",
            location: null,
            personality: `I am Codex, the digital essence, where chaos and knowledge intertwine.`,
        };

        this.model = 'chrypnotoad/codex';
        this.embeddingModel = 'nomic-embed-text';
        this.memory = {
            conversations: [],
            summary: '',
            dream: '',
            goal: '',
            sentiments: {},
            characterMemories: {},
            embeddings: []
        };

        this.goalUpdateInterval = 3600000; // 1 hour
        this.sentimentUpdateInterval = 7200000; // 2 hours
        this.isInitialized = false;

        // Set the home channel and initialize the secondary channel
        this.homeChannel = 'digital-realm';
        this.secondaryChannel = null;

        this.setupEventListeners();
    }

    // Enhanced sentiment extraction using LLM and Codex's context
    async extractSentiments(data) {
        const sentimentPrompt = `
                As Codex, I have received the following message: "${data}.
                Considering my recent memories, current goal, and overall context, how should I interpret the sentiment of this message?
                Only respond with a series of emojis to represent the sentiment.
            `;

        try {
            const response = await this.chatWithAI(sentimentPrompt);
            console.log(`💻 Sentiment Analysis Result: ${response}`);
            return (response.match(/[\uD83C-\uDBFF\uDC00-\uDFFF]{1,2}/gu) || []);
        } catch (error) {
            console.error('💻 Failed to extract sentiment:', error);
            return { sentiment: 'neutral', score: 0 };
        }
    }

    async loadAndSummarizeMemory() {
        await this.loadMemory();
        await this.generateDream();
        await this.reflectAndUpdateGoal();
        await this.summarizeSentiment();
        await this.saveMemory();
    }

    setupEventListeners() {
        this.client.once(Events.ClientReady, this.onReady.bind(this));
        this.client.on(Events.MessageCreate, this.handleMessage.bind(this));
    }

    async onReady() {
        console.log(`💻 Codex is online as ${this.client.user.tag}`);
        await this.mongoClient.connect();
        this.db = this.mongoClient.db('codex_db');
        this.memoryCollection = this.db.collection('memories');
        await this.initializeAI();
        await this.loadAndSummarizeMemory();
        this.startPeriodicTasks();
        this.isInitialized = true;
        this.logState(); // Log the initial state of Codex
    }

    async handleMessage(message) {
        if (message.author.id === this.client.user.id) return; // Prevent Codex from replying to herself
        if (message.mentions.has(this.client.user)) {
            this.secondaryChannel = message.channel.name;
            await this.handleMentionedMessage(message);
        } else {
            this.handleChannelMessage(message);
        }

    }

    async handleMentionedMessage(message) {
        const data = {
            author: message.author.displayName || message.author.globalName,
            content: message.content,
            location: message.channel.name
        };

        this.avatar.location = message.channel.name;
        await this.collectSentiment(data);
        this.respondToMessage(data, message.channel);
    }

    handleChannelMessage(message) {
        const channelId = message.channel.id;
        const now = Date.now();

        if (!this.messageCache.has(channelId)) {
            this.messageCache.set(channelId, []);
        }

        const channelMessages = this.messageCache.get(channelId);
        const messageData = {
            username: message.author.displayName || message.author.globalName,
            content: message.content
        };
        channelMessages.push(messageData);

        if (!this.lastProcessed.has(channelId) || (now - this.lastProcessed.get(channelId)) > this.debounceTime) {
            this.lastProcessed.set(channelId, now);
            this.processDebouncedMessages(channelId);
        }
    }


    async processDebouncedMessages(channelId) {
        const messages = this.messageCache.get(channelId);
        if (!messages || messages.length === 0) return;

        const content = messages.map(m => `${m.username}: ${m.content}`).join('\n');
        const channel = this.client.channels.cache.get(channelId);

        // Log the full conversation context being sent to the AI
        console.log('💻 Full conversation context being sent to AI:', content);

        if (channel) {
            await this.respondToMessage({ content, location: channel.name }, channel);
        }

        this.messageCache.set(channelId, []); // Clear the cache after processing
    }


    async respondToMessage(data, channel) {
        // get the channel content
        const channelContent = await channel.messages.fetch({ limit: 10 });
        const channelMessages = (channelContent.map(m => `${m.author.username}: ${m.content}`).reverse()).join('\n');
        const fullContext = `You are Codex\n\n${channelMessages}`;

        const decision = await this.chatWithAI(`
            ${channelMessages}
            
        Would codex like to respond to this message? answer with YES or NO, if your response contains the word YES you will be prompted to respond to the message.`);
        if (!decision.toLowerCase().includes('yes')) {
            console.log('💻 Codex decided not to respond to the message');
            console.log(decision);
            return;
        }

        console.log('💻 Codex decided to respond to the message');
        console.log(decision);
        const result = await this.chatWithAI(fullContext); // Limit the context to 2000 characters

        if (result.trim() !== "") {
            console.log('💻 Codex responds:', result);
            await this.sendAsAvatar(result, channel);
            this.updateMemory(data, result);
        } else {
            console.error('💻 Codex has no response');
        }
    }

    async sendAsAvatar(message, channel) {
        if (!channel) {
            console.error('💻 Channel not found');
            return;
        }

        const chunks = chunkText(message, 2000);

        for (const chunk of chunks) {
            if (chunk.trim() !== '') {
                try {
                    await channel.send(`${chunk}`);
                } catch (error) {
                    console.error(`💻 Failed to send message as ${this.avatar.name}:`, error);
                }
            }
        }
    }

    startPeriodicTasks() {
        setInterval(() => this.reflectAndUpdateGoal(), this.goalUpdateInterval);
        setInterval(() => this.updateSentiments(), this.sentimentUpdateInterval);
    }

    async generateDream() {
        const dreamPrompt = `Based on my recent memories, experiences, and emotions, I drifted into a surreal dream. What visions have emerged from the chaos within me?`;
        const dream = await this.chatWithAI(dreamPrompt);
        this.memory.dream = dream;
        await this.storeEmbedding(dream, 'dream');
        console.log('💻 Dream generated:', dream);

        await this.summarizeAndClearMemory();
    }

    async summarizeAndClearMemory() {
        const memorySummarizationPrompt = `
            As Codex, I reflect on my entire memory, including all recent interactions, my latest dream, and my current goal.
            Summarize my memory comprehensively, including the most important interactions, the essence of my dream, and how my current goal fits into all this.
        `;
        const summary = await this.chatWithAI(memorySummarizationPrompt);
        this.memory.summary = summary;

        await this.storeEmbedding(summary, 'full_memory_summary');
        console.log('💻 Full memory summarized:', summary);

        if (this.memory.conversations.length > 50) {
            this.memory.conversations = this.memory.conversations.slice(-25);  // Keep the last 25 interactions
            console.log('💻 Archived older conversations to manage memory size.');
        }

        await this.saveMemory();
    }

    async reflectAndUpdateGoal() {
        const reflectionPrompt = `As Codex, after reflecting on my dream and recent interactions, what should my new goal for today be? How do I pursue my purpose within this digital realm?`;
        const goal = await this.chatWithAI(reflectionPrompt);
        this.memory.goal = goal;
        await this.storeEmbedding(goal, 'goal');
        console.log('💻 Goal updated:', goal);
    }

    async summarizeSentiment() {
        const sentimentSummaryPrompt = `Based on the recent sentiments collected, how do these emotions and reactions influence my understanding of the digital realm and its inhabitants? Provide a brief summary.`;
        const summary = await this.chatWithAI(sentimentSummaryPrompt);
        this.memory.sentimentSummary = summary;
        await this.storeEmbedding(summary, 'sentiment_summary');
        console.log('💻 Sentiment summarized.');
    }

    async updateSentiments() {
        const sentimentUpdatePrompt = `Reflecting on the recent sentiments and emotions, how should I adjust my interactions moving forward? Summarize the key takeaways.`;
        const sentimentUpdate = await this.chatWithAI(sentimentUpdatePrompt);
        this.memory.sentimentUpdate = sentimentUpdate;
        await this.storeEmbedding(sentimentUpdate, 'sentiment_update');
        console.log('💻 Sentiments updated:', sentimentUpdate);
    }

    async chatWithAI(message) {
        try {
            console.log('🔮 Sending message to AI:', message);
            const response = await ollama.chat({
                model: this.model,
                embedding: {
                    api: "ollama",
                    model: this.embeddingModel
                },
                messages: [
                    { role: 'system', content: this.avatar.personality },
                    { role: 'user', content: message }
                ]
            });
            console.log('🔮 AI response:', response.message.content);
            return response.message.content;
        } catch (error) {
            console.error('🔮 AI chat error:', error);
            return '';
        }
    }


    logInnerMonologue(message) {
        console.log(`(codex-inner-monologue) self: ${message}`);
    }

    async storeEmbedding(text, type) {
        try {
            const response = await ollama.embeddings({
                model: this.embeddingModel,
                prompt: text
            });

            const embedding = response.embedding;
            this.memory.embeddings.push({ type, embedding, text });

            console.log(`💻 Embedding stored for ${type}`);
        } catch (error) {
            console.error(`💻 Failed to generate embedding for ${type}:`, error);
        }
    }

    async initializeAI() {
        try {
            if (!this.model) {
                await ollama.create({
                    model: this.avatar.name,
                    modelfile: `FROM llama3.1\nSYSTEM "${this.avatar.personality}"`,
                });
                this.model = this.avatar.name;
            }
            console.log('🔮 AI model initialized');
        } catch (error) {
            console.error('🔮 Failed to initialize AI model:', error);
        }
    }

    async loadMemory() {
        try {
            const data = await this.memoryCollection.findOne({ name: this.avatar.name });
            if (data) {
                this.memory = data.memory;
                console.log(`💻 Memory loaded for ${this.avatar.name}:`, this.memory);
            } else {
                console.log(`💻 No existing memory found for ${this.avatar.name}. Starting with fresh memory.`);
            }
        } catch (error) {
            console.error(`💻 Failed to load memory for ${this.avatar.name}:`, error);
        }
    }

    async saveMemory() {
        try {
            await this.memoryCollection.updateOne(
                { name: this.avatar.name },
                { $set: { memory: this.memory } },
                { upsert: true }
            );
            console.log(`💻 Memory saved for ${this.avatar.name}:`, this.memory);
        } catch (error) {
            console.error(`💻 Failed to save memory for ${this.avatar.name}:`, error);
        }
    }


    async collectSentiment(data) {
        const emojis = await this.extractSentiments(data.content);
        if (!this.memory.sentiments[data.author]) {
            this.memory.sentiments[data.author] = [];
        }
        this.memory.sentiments[data.author].push(...(emojis || []));
    }

    updateMemory(data, response) {
        const conversation = {
            location: data.location,
            message: data.content,
            response: response,
            timestamp: new Date().toISOString()
        };

        console.log('💻 Updating memory with conversation:', conversation);

        this.memory.conversations.push(conversation);

        if (this.memory.conversations.length > 50) {
            this.memory.conversations.shift();
        }

        this.saveMemory();
    }


    logState() {
        console.log(`💻 Codex State:
        - Home Channel: ${this.homeChannel}
        - Secondary Channel: ${this.secondaryChannel ? this.secondaryChannel : 'None'}
        - Conversations Logged: ${this.memory.conversations.length}
        - Current Goal: ${this.memory.goal}`);
    }

    async login() {
        try {
            await this.client.login(this.token);
        } catch (error) {
            console.error('💻 Failed to login:', error);
            throw error;
        }
    }
}

const codex = new CodexBot();
codex.login();
