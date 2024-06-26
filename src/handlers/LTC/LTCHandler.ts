
import BigNumber from "bignumber.js";
import * as bitcoin from "bitgo-utxo-lib";
import { List } from "immutable";
import { Sochain } from "../../common/apis/sochain";
import { BitgoUTXOLib } from "../../common/libraries/bitgoUtxoLib";
import { subscribeToConfirmations } from "../../lib/confirmations";
import { newPromiEvent, PromiEvent } from "../../lib/promiEvent";
import { fallback, retryNTimes } from "../../lib/retry";
import { UTXO } from "../../lib/utxo";
import { Asset, Handler } from "../../types/types";

interface AddressOptions {}
interface BalanceOptions extends AddressOptions {
    address?: string;
    confirmations?: number; // defaults to 0
}
interface TxOptions extends BalanceOptions {
    fee?: number; // defaults to 10000
    subtractFee?: boolean; // defaults to false
}

export const _apiFallbacks = {
    fetchUTXO: (testnet: boolean, txHash: string, vOut: number) => [
        () => Sochain.fetchUTXO(testnet ? "LTCTEST" : "LTC")(txHash, vOut),
    ],

    fetchUTXOs: (
        testnet: boolean,
        address: string,
        confirmations: number,
        scriptHash?: string
    ) => [
        () =>
            Sochain.fetchUTXOs(testnet ? "LTCTEST" : "LTC")(
                address,
                confirmations
            ),
    ],

    fetchTXs: (
        testnet: boolean,
        address: string,
        confirmations: number = 0,
        scriptHash?: string
    ) => [
        () =>
            Sochain.fetchTXs(testnet ? "LTCTEST" : "LTC")(
                address,
                confirmations
            ),
    ],

    broadcastTransaction: (testnet: boolean, hex: string) => [
        () => Sochain.broadcastTransaction(testnet ? "LTCTEST" : "LTC")(hex),
    ],
};

export class LTCHandler implements Handler {
    private readonly privateKey: { getAddress: () => string };
    private readonly testnet: boolean;

    private readonly decimals = 8;

    static getUTXOs = async (
        testnet: boolean,
        options: {
            address: string;
            confirmations?: number;
            scriptHash?: string;
        }
    ): Promise<readonly UTXO[]> => {
        const confirmations =
            options && options.confirmations !== undefined
                ? options.confirmations
                : 0;

        const endpoints = _apiFallbacks.fetchUTXOs(
            testnet,
            options.address,
            confirmations,
            options.scriptHash
        );

        return fallback(endpoints);
    };

    static getUTXO = async (
        testnet: boolean,
        txHash: string,
        vOut: number
    ): Promise<UTXO> => {
        const endpoints = _apiFallbacks.fetchUTXO(testnet, txHash, vOut);
        return fallback(endpoints);
    };

    static getTransactions = async (
        testnet: boolean,
        options: {
            address: string;
            confirmations?: number;
            scriptHash?: string;
        }
    ): Promise<readonly UTXO[]> => {
        const confirmations =
            options && options.confirmations !== undefined
                ? options.confirmations
                : 0;

        const endpoints = _apiFallbacks.fetchTXs(
            testnet,
            options.address,
            confirmations,
            options.scriptHash
        );
        return fallback(endpoints);
    };

    constructor(privateKey: string, network: string) {
        this.testnet = network !== "mainnet";
        this.privateKey = BitgoUTXOLib.loadPrivateKey(
            this.testnet
                ? bitcoin.networks.litecoinTest
                : bitcoin.networks.litecoin,
            privateKey
        );
    }

    // Returns whether or not this can handle the asset
    public readonly handlesAsset = (asset: Asset): boolean =>
        typeof asset === "string" &&
        ["LTC", "LITECOIN"].indexOf(asset.toUpperCase()) !== -1;

    public readonly address = async (
        asset: Asset,
        options?: AddressOptions
    ): Promise<string> => this.privateKey.getAddress();

    // Balance
    public readonly getBalance = async (
        asset: Asset,
        options?: BalanceOptions
    ): Promise<BigNumber> =>
        (await this.getBalanceInSats(asset, options)).dividedBy(
            new BigNumber(10).exponentiatedBy(this.decimals)
        );

    public readonly getBalanceInSats = async (
        asset: Asset,
        options?: BalanceOptions
    ): Promise<BigNumber> => {
        const utxos = await LTCHandler.getUTXOs(this.testnet, {
            ...options,
            address:
                (options && options.address) || (await this.address(asset)),
        });
        return utxos.reduce(
            (sum, utxo) => sum.plus(utxo.amount),
            new BigNumber(0)
        );
    };

    // Transfer
    public readonly send = (
        to: string,
        value: BigNumber,
        asset: Asset,
        options?: TxOptions
    ): PromiEvent<string> =>
        this.sendSats(
            to,
            value.times(new BigNumber(10).exponentiatedBy(this.decimals)),
            asset,
            options
        );

    public readonly sendSats = (
        to: string,
        valueIn: BigNumber,
        asset: Asset,
        options?: TxOptions
    ): PromiEvent<string> => {
        const promiEvent = newPromiEvent<string>();

        let txHash: string;
        let errored: boolean;

        (async () => {
            const fromAddress = await this.address(asset);
            const changeAddress = fromAddress;
            const utxos = List(
                await LTCHandler.getUTXOs(this.testnet, {
                    ...options,
                    address: fromAddress,
                })
            )
                .sortBy((utxo) => utxo.amount)
                .reverse()
                .toArray();

            const built = await BitgoUTXOLib.buildUTXO(
                this.testnet
                    ? bitcoin.networks.litecoinTest
                    : bitcoin.networks.litecoin,
                this.privateKey,
                changeAddress,
                to,
                valueIn,
                utxos,
                options
            );

            txHash = await retryNTimes(
                () =>
                    fallback(
                        _apiFallbacks.broadcastTransaction(
                            this.testnet,
                            built.toHex()
                        )
                    ),
                3
            );

            promiEvent.emit("transactionHash", txHash);
            promiEvent.resolve(txHash);
        })().catch((error) => {
            errored = true;
            promiEvent.reject(error);
        });

        subscribeToConfirmations(
            promiEvent,
            () => errored,
            async () => (txHash ? this._getConfirmations(txHash) : 0)
        );

        return promiEvent;
    };

    private readonly _getConfirmations = async (
        txHash: string
    ): Promise<number> =>
        (
            await fallback(
                // Fetch confirmations for first output of transaction.
                _apiFallbacks.fetchUTXO(this.testnet, txHash, 0)
            )
        ).confirmations;
}
