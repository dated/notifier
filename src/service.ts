import { Container, Contracts, Enums as AppEnums, Services, Utils as AppUtils } from "@arkecosystem/core-kernel";
import { Interfaces, Managers, Utils as CryptoUtils } from "@arkecosystem/crypto";
import axios from "axios";
import os from "os";

import { IOptions } from "./interface";
import * as messages from "./messages";

const VALID_EVENTS = [
    "block.applied",
    "block.forged",
    "block.reverted",
    "delegate.registered",
    "delegate.resigned",
    "forger.failed",
    "forger.missing",
    "forger.started",
    "peer.added",
    "peer.removed",
    "transaction.applied",
    "transaction.expired",
    "transaction.forged",
    "transaction.reverted",
    "wallet.vote",
    "wallet.unvote",
    "round.created",
    "round.missed",
    "activedelegateschanged",
];

const LOG_PREFIX = "[deadlock-delegate/notifier]";

const CUSTOM_EVENTS = ["activedelegateschanged"];
const CUSTOM_EVENT_MAPPING = {
    activedelegateschanged: AppEnums.BlockEvent.Applied,
};

let LAST_ACTIVE_DELEGATES_CACHED: string[] = [];

@Container.injectable()
export default class Service {
    @Container.inject(Container.Identifiers.EventDispatcherService)
    private readonly emitter!: Contracts.Kernel.EventDispatcher;

    @Container.inject(Container.Identifiers.LogService)
    private readonly logger!: Contracts.Kernel.Logger;

    @Container.inject(Container.Identifiers.TriggerService)
    private readonly triggers!: Services.Triggers.Triggers;

    // @Container.inject(Container.Identifiers.DposState)
    // @Container.tagged("state", "clone")
    // private readonly dposState!: Contracts.State.DposState;

    @Container.inject(Container.Identifiers.WalletRepository)
    // why state, blockchain - why not state, clone?
    @Container.tagged("state", "blockchain")
    private readonly walletRepository!: Contracts.State.WalletRepository;

    private events = {};
    private explorerTxUrl: string = "";

    public async listen(options: IOptions): Promise<void> {
        Managers.configManager.setFromPreset("mainnet");

        LAST_ACTIVE_DELEGATES_CACHED = await this.getActiveDelegates();

        this.explorerTxUrl = options.explorerTx;

        for (const webhook of options.webhooks) {
            for (const event of webhook.events) {
                if (!VALID_EVENTS.includes(event)) {
                    this.logger.warning(
                        `${LOG_PREFIX} ${event} is not a valid event. Check events in your deadlock-notifier configuration`,
                    );
                    continue;
                }

                if (!this.events[event]) {
                    this.events[event] = [];
                }

                this.events[event].push({
                    endpoint: webhook.endpoint,
                    payload: webhook.payload,
                });
            }
        }
        Object.keys(this.events).forEach((event) => this.subscribe(event));
    }

    private async getActiveDelegates() {
        // im not sure why I need to use triggers, but trying to inject dposState and calling
        // getActiveDelegates method from there didn't work
        const activeDelegates: Contracts.State.Wallet[] | undefined = await this.triggers.call(
            "getActiveDelegates",
            {},
        );

        if (!activeDelegates) {
            return [];
        }

        return activeDelegates.map((wallet) => wallet.getAttribute("delegate.username"));
    }

    private subscribe(event: string) {
        let customEventName: string | undefined = undefined;
        if (CUSTOM_EVENTS.includes(event)) {
            customEventName = event;
            event = CUSTOM_EVENT_MAPPING[event];
        }

        // for some yet unknown reason, if handlers are defined at the class level, we can not access
        // walletRepositoiry or triggers (or other) within each handle functions
        const handlers = {
            [AppEnums.VoteEvent.Vote]: this.walletVote.bind({ walletRepository: this.walletRepository }),
            [AppEnums.VoteEvent.Unvote]: this.walletUnvote.bind({ walletRepository: this.walletRepository }),
            [AppEnums.ForgerEvent.Missing]: this.forgerMissing,
            [AppEnums.ForgerEvent.Failed]: this.forgerFailed,
            [AppEnums.ForgerEvent.Started]: this.forgerStarted,
            [AppEnums.BlockEvent.Forged]: this.blockForged,
            [AppEnums.RoundEvent.Created]: this.roundCreated,
            [AppEnums.DelegateEvent.Registered]: this.delegateRegistered,
            [AppEnums.DelegateEvent.Resigned]: this.delegateResigned.bind({ walletRepository: this.walletRepository }),
            activedelegateschanged: this.activeDelegatesChanged.bind({ triggers: this.triggers }),
        };

        this.emitter.listen(event, {
            handle: async (payload: any) => {
                let { name, data } = payload;

                // ignore unvote event when switching votes
                if (
                    name === AppEnums.VoteEvent.Unvote &&
                    ((data.transaction as Interfaces.ITransactionData)?.asset?.votes ?? []).length > 1
                ) {
                    return;
                }

                // this.logger.debug(`${LOG_PREFIX} Received ${name}: ${JSON.stringify(data)}`);

                if (customEventName === "activedelegateschanged") {
                    name = "activedelegateschanged";
                }

                const webhooks = this.events[name];

                if (!(name in handlers)) {
                    this.logger.error(`${LOG_PREFIX} ${name} does not have a handler yet`);
                    return;
                }

                const messageData: null | any[] = await handlers[name](data);
                if (!messageData) {
                    return;
                }

                messageData.push(this.explorerTxUrl);

                const requests: Promise<any>[] = [];
                for (const webhook of webhooks) {
                    const platform = this.detectPlatform(webhook.endpoint);
                    const message = this.getMessage(platform, name, messageData);
                    // todo: `webhook.payload.msg` is the name of the message field eg. discord has "content", slack has "text", make this a bit smarter ;)
                    payload[webhook.payload.msg] = message;

                    // todo: this should be nicer so no checks for platform === pushover would be needed
                    // quick change to handle pushover a little differently
                    if (platform === "pushover") {
                        if (!webhook.payload.token || !webhook.payload.user) {
                            this.logger.error(
                                `${LOG_PREFIX} Unable to setup pushover notifications. User and token params must be set`,
                            );
                            continue;
                        }
                        payload = { ...payload, token: webhook.payload.token, user: webhook.payload.user };
                    }
                    requests.push(axios.post(webhook.endpoint, payload));
                }

                // don't care about the response msg except if there's an error
                try {
                    if (name === AppEnums.VoteEvent.Vote) {
                        await AppUtils.sleep(1000);
                    }
                    await Promise.all(requests);
                } catch (err) {
                    this.logger.error(`${LOG_PREFIX} ${err}`);
                }
            },
        });
    }

    private getMessage(platform: string, event: string, data: any) {
        // todo: this should be nicer so no checks for platform === pushover would be needed
        if (platform === "pushover") {
            platform = "fallback";
        }

        return messages[platform][event](...data);
    }

    private detectPlatform(endpoint: string) {
        if (endpoint.includes("hooks.slack.com")) {
            return "slack";
        } else if (endpoint.includes("discordapp.com") || endpoint.includes("discord.com")) {
            return "discord";
        } else if (endpoint.includes("pushover.net")) {
            return "pushover";
        }

        return "fallback";
    }

    private async walletVote({
        delegate,
        transaction,
    }: {
        delegate: string;
        transaction: Interfaces.ITransactionData;
    }): Promise<any[]> {
        AppUtils.assert.defined<string>(transaction.senderPublicKey);

        const voterWallet = this.walletRepository.findByPublicKey(transaction.senderPublicKey);

        const votes: string[] = transaction.asset!.votes!;

        if (votes.length > 1) {
            let votedDelegateWallet!: Contracts.State.Wallet;
            let unvotedDelegateWallet!: Contracts.State.Wallet;

            for (const vote of votes) {
                if (vote.startsWith("+")) {
                    votedDelegateWallet = this.walletRepository.findByPublicKey(vote.replace("+", ""));
                }

                if (vote.startsWith("-")) {
                    unvotedDelegateWallet = this.walletRepository.findByPublicKey(vote.replace("-", ""));
                }
            }

            return [
                voterWallet.getAddress(),
                {
                    vote: votedDelegateWallet.getAttribute("delegate.username"),
                    unvote: unvotedDelegateWallet.getAttribute("delegate.username"),
                },
                CryptoUtils.formatSatoshi(voterWallet.getBalance()),
                transaction.id,
            ];
        }

        const delegateWallet = this.walletRepository.findByPublicKey(delegate.replace("+", ""));

        return [
            voterWallet.getAddress(),
            { vote: delegateWallet.getAttribute("delegate.username") },
            CryptoUtils.formatSatoshi(voterWallet.getBalance()),
            transaction.id,
        ];
    }

    private async walletUnvote({
        delegate,
        transaction,
    }: {
        delegate: string;
        transaction: Interfaces.ITransactionData;
    }): Promise<any[]> {
        AppUtils.assert.defined<string>(transaction.senderPublicKey);

        const delegateWallet = this.walletRepository.findByPublicKey(delegate.replace("-", ""));
        const voterWallet = this.walletRepository.findByPublicKey(transaction.senderPublicKey);

        return [
            voterWallet.getAddress(),
            { unvote: delegateWallet.getAttribute("delegate.username") },
            CryptoUtils.formatSatoshi(voterWallet.getBalance()),
            transaction.id,
        ];
    }

    private async forgerMissing(wallet: any): Promise<any[]> {
        const delegateName = wallet.delegate.getAttribute("delegate.username");
        return [os.hostname(), delegateName];
    }

    private async forgerFailed(error): Promise<any[]> {
        return [os.hostname(), error];
    }

    private async forgerStarted(data): Promise<any[]> {
        return [os.hostname];
    }

    private async blockForged(block: Interfaces.IBlock): Promise<any[]> {
        return [os.hostname(), block.data.id];
    }

    private async roundCreated(activeDelegates: Contracts.State.Wallet[]): Promise<any[]> {
        return [activeDelegates];
    }

    private async activeDelegatesChanged(block: Interfaces.IBlock): Promise<any[] | null> {
        const previouslyActiveDelegates = LAST_ACTIVE_DELEGATES_CACHED;
        const latestDelegates = (await this.triggers.call("getActiveDelegates", {})) as Contracts.State.Wallet[];

        if (!latestDelegates) {
            return [];
        }

        const newActiveDelegates = latestDelegates.map((wallet) => wallet.getAttribute("delegate.username"));

        const droppedOutDelegates = previouslyActiveDelegates.filter((x) => !newActiveDelegates.includes(x));
        const newDelegates = newActiveDelegates.filter((x) => !previouslyActiveDelegates.includes(x));

        if (droppedOutDelegates.length === 0 && newDelegates.length === 0) {
            return null;
        }

        // cache new active delegates for the next round so we know which ones change
        LAST_ACTIVE_DELEGATES_CACHED = newActiveDelegates;

        return [newDelegates, droppedOutDelegates];
    }

    private async delegateRegistered(transaction: Interfaces.ITransactionData): Promise<any[]> {
        return [transaction.asset?.delegate?.username];
    }

    private async delegateResigned(transaction: Interfaces.ITransactionData): Promise<any[] | null> {
        const senderPublicKey = transaction.senderPublicKey;

        if (!senderPublicKey) {
            return null;
        }

        const wallet = this.walletRepository.findByPublicKey(senderPublicKey);

        return [wallet.getAttribute("delegate.username")];
    }
}
