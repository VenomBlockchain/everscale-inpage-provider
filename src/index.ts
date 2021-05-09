import {
  ProviderApi,
  ProviderEvent,
  ProviderEventData,
  ProviderMethod,
  ProviderRequestParams,
  ProviderResponse
} from './api';
import {
  ContractUpdatesSubscription,
  TokensObject,
  Transaction,
  TransactionsBatchInfo
} from './models';
import {
  AbiFunctionName,
  AbiFunctionParams,
  AbiFunctionOutput,
  Address,
  AddressLiteral,
  AbiParam,
  ParsedTokensObject,
  transformToSerializedObject,
  transformToParsedObject,
  getUniqueId
} from './utils';

export * from './api';
export * from './models';
export * from './permissions';
export { Address, AddressLiteral } from './utils';

export interface TonRequest<T extends ProviderMethod> {
  method: T
  params: ProviderRequestParams<T>
}

export interface Ton {
  addListener<T extends ProviderEvent>(eventName: T, listener: (data: ProviderEventData<T>) => void): void

  removeListener<T extends ProviderEvent>(eventName: T, listener: (data: ProviderEventData<T>) => void): void

  on<T extends ProviderEvent>(eventName: T, listener: (data: ProviderEventData<T>) => void): void

  once<T extends ProviderEvent>(eventName: T, listener: (data: ProviderEventData<T>) => void): void

  prependListener<T extends ProviderEvent>(eventName: T, listener: (data: ProviderEventData<T>) => void): void

  prependOnceListener<T extends ProviderEvent>(eventName: T, listener: (data: ProviderEventData<T>) => void): void

  request<T extends ProviderMethod>(data: TonRequest<T>): Promise<ProviderResponse<T>>
}

type RpcMethod<P extends ProviderMethod> = ProviderRequestParams<P> extends {}
  ? (args: ProviderRequestParams<P>) => Promise<ProviderResponse<P>>
  : () => Promise<ProviderResponse<P>>

type ProviderApiMethods = {
  [P in ProviderMethod]: RpcMethod<P>
}

let ensurePageLoaded: Promise<void>;
if (document.readyState == 'complete') {
  ensurePageLoaded = Promise.resolve();
} else {
  ensurePageLoaded = new Promise<void>((resolve) => {
    window.addEventListener('load', () => {
      resolve();
    });
  });
}

export async function hasTonProvider() {
  await ensurePageLoaded;
  return (window as Record<string, any>).hasTonProvider === true;
}

/**
 * Modifies knownTransactions array, merging it with new transactions.
 * All arrays are assumed to be sorted by descending logical time.
 *
 * > Note! This method does not remove duplicates.
 *
 * @param knownTransactions
 * @param newTransactions
 * @param info
 */
export function mergeTransactions(
  knownTransactions: Transaction[],
  newTransactions: Transaction[],
  info: TransactionsBatchInfo
): Transaction[] {
  if (info.batchType == 'old') {
    knownTransactions.push(...newTransactions);
    return knownTransactions;
  }

  if (knownTransactions.length === 0) {
    knownTransactions.push(...newTransactions);
    return knownTransactions;
  }

  // Example:
  // known lts: [N, N-1, N-2, N-3, (!) N-10,...]
  // new lts: [N-4, N-5]
  // batch info: { minLt: N-5, maxLt: N-4, batchType: 'new' }

  // 1. Skip indices until known transaction lt is greater than the biggest in the batch
  let i = 0;
  while (
    i < knownTransactions.length &&
    knownTransactions[i].id.lt.localeCompare(info.maxLt) >= 0
    ) {
    ++i;
  }

  // 2. Insert new transactions
  knownTransactions.splice(i, 0, ...newTransactions);
  return knownTransactions;
}

type SubscriptionEvent = 'data' | 'subscribed' | 'unsubscribed';

export interface ISubscription<T extends ProviderEvent> {
  /**
   * Fires on each incoming event with the event object as argument.
   *
   * @param eventName 'data'
   * @param listener
   */
  on(eventName: 'data', listener: (data: ProviderEventData<T>) => void): this;

  /**
   * Fires on successful re-subscription
   *
   * @param eventName 'subscribed'
   * @param listener
   */
  on(eventName: 'subscribed', listener: () => void): this;

  /**
   * Fires on unsubscription
   *
   * @param eventName 'unsubscribed'
   * @param listener
   */
  on(eventName: 'unsubscribed', listener: () => void): this;

  /**
   * Can be used to re-subscribe with the same parameters.
   */
  subscribe(): Promise<void>;

  /**
   * Unsubscribes the subscription.
   */
  unsubscribe(): Promise<void>
}

class ProviderRpcClient {
  private readonly _api: ProviderApiMethods;
  private readonly _initializationPromise: Promise<void>;
  private readonly _subscriptions: { [K in ProviderEvent]?: { [id: number]: (data: ProviderEventData<K>) => void } } = {};
  private readonly _contractSubscriptions: { [address: string]: { [id: number]: ContractUpdatesSubscription } } = {};
  private _ton?: Ton;

  constructor() {
    this._api = new Proxy({}, {
      get: <K extends ProviderMethod>(
        _object: ProviderRpcClient,
        method: K
      ) => (params?: ProviderRequestParams<K>) => this._ton!.request({ method, params: params! })
    }) as unknown as ProviderApiMethods;

    this._ton = (window as any).ton;
    if (this._ton != null) {
      this._initializationPromise = Promise.resolve();
    } else {
      this._initializationPromise = hasTonProvider().then((hasTonProvider) => new Promise((resolve, reject) => {
        if (!hasTonProvider) {
          reject(new Error('TON provider was not found'));
          return;
        }

        this._ton = (window as any).ton;
        if (this._ton != null) {
          resolve();
        } else {
          window.addEventListener('ton#initialized', (_data) => {
            this._ton = (window as any).ton;
            resolve();
          });
        }
      }));
    }

    this._initializationPromise.then(() => {
      if (this._ton == null) {
        return;
      }

      const knownEvents: ProviderEvent[] = [
        'disconnected',
        'transactionsFound',
        'contractStateChanged',
        'networkChanged',
        'permissionsChanged',
        'loggedOut'
      ];

      for (const eventName of knownEvents) {
        this._ton.addListener(eventName, (data) => {
          const handlers = this._subscriptions[eventName];
          if (handlers == null) {
            return;
          }
          for (const handler of Object.values(handlers)) {
            handler(data);
          }
        });
      }
    });
  }

  public async ensureInitialized() {
    await this._initializationPromise;
  }

  public get isInitialized() {
    return this._ton != null;
  }

  public get raw() {
    return this._ton!;
  }

  public get api() {
    return this._api;
  }

  public subscribe(eventName: 'disconnected'): Promise<ISubscription<'disconnected'>>;
  public subscribe(eventName: 'transactionsFound', params: { address: Address }): Promise<ISubscription<'transactionsFound'>>;
  public subscribe(eventName: 'contractStateChanged', params: { address: Address }): Promise<ISubscription<'contractStateChanged'>>;
  public subscribe(eventName: 'networkChanged'): Promise<ISubscription<'networkChanged'>>;
  public subscribe(eventName: 'permissionsChanged'): Promise<ISubscription<'permissionsChanged'>>;
  public subscribe(eventName: 'loggedOut'): Promise<ISubscription<'loggedOut'>>;
  public async subscribe<T extends ProviderEvent>(eventName: T, params?: { address: Address }): Promise<ISubscription<T>> {
    class Subscription implements ISubscription<T> {
      private readonly _listeners: { [K in SubscriptionEvent]: ((data?: any) => void)[] } = {
        ['data']: [],
        ['subscribed']: [],
        ['unsubscribed']: []
      };

      constructor(
        private readonly _subscribe: (s: Subscription) => Promise<void>,
        private readonly _unsubscribe: () => Promise<void>) {
      }

      on(eventName: 'data', listener: (data: ProviderEventData<T>) => void): this;
      on(eventName: 'subscribed', listener: () => void): this;
      on(eventName: 'unsubscribed', listener: () => void): this;
      on(eventName: SubscriptionEvent, listener: ((data: ProviderEventData<T>) => void) | (() => void)): this {
        this._listeners[eventName].push(listener);
        return this;
      }

      async subscribe(): Promise<void> {
        await this._subscribe(this);
        for (const handler of this._listeners['subscribed']) {
          handler();
        }
      }

      async unsubscribe(): Promise<void> {
        await this._unsubscribe();
        for (const handler of this._listeners['unsubscribed']) {
          handler();
        }
      }

      notify(data: ProviderEventData<T>) {
        for (const handler of this._listeners['data']) {
          handler(data);
        }
      }
    }

    let existingSubscriptions = this._getEventSubscriptions(eventName);

    const id = getUniqueId();

    switch (eventName) {
      case 'disconnected':
      case 'networkChanged':
      case 'permissionsChanged':
      case 'loggedOut': {
        const subscription = new Subscription(async (subscription) => {
          if (existingSubscriptions[id] != null) {
            return;
          }
          existingSubscriptions[id] = (data) => {
            subscription.notify(data);
          };
        }, async () => {
          delete existingSubscriptions[id];
        });
        await subscription.subscribe();
        return subscription;
      }
      case 'transactionsFound':
      case 'contractStateChanged': {
        const address = params!.address.toString();

        const subscription = new Subscription(async (subscription) => {
          if (existingSubscriptions[id] != null) {
            return;
          }
          existingSubscriptions[id] = (data) => {
            subscription.notify(data);
          };

          let contractSubscriptions = this._contractSubscriptions[address];
          if (contractSubscriptions == null) {
            contractSubscriptions = {};
            this._contractSubscriptions[address] = contractSubscriptions;
          }

          contractSubscriptions[id] = {
            state: eventName == 'contractStateChanged',
            transactions: eventName == 'transactionsFound'
          };

          const { before, after } = foldSubscriptions(Object.values(contractSubscriptions), contractSubscriptions[id]);

          try {
            if (before.transactions != after.transactions || before.state != after.state) {
              await this.api.subscribe({ address, subscriptions: after });
            }
          } catch (e) {
            delete existingSubscriptions[id];
            delete contractSubscriptions[id];
            throw e;
          }
        }, async () => {
          delete existingSubscriptions[id];

          const contractSubscriptions = this._contractSubscriptions[address];
          if (contractSubscriptions == null) {
            return;
          }
          const updates = contractSubscriptions[id];

          const { before, after } = foldSubscriptions(Object.values(contractSubscriptions), updates);
          delete contractSubscriptions[id];

          if (!after.transactions && !after.state) {
            await this.api.unsubscribe({ address });
          } else if (before.transactions != after.transactions || before.state != after.state) {
            await this.api.subscribe({ address, subscriptions: after });
          }
        });
        await subscription.subscribe();
        return subscription;
      }
      default: {
        throw new Error(`Unknown event ${eventName}`);
      }
    }
  }

  private _getEventSubscriptions<T extends ProviderEvent>(
    eventName: T
  ): ({ [id: number]: (data: ProviderEventData<T>) => void }) {
    let existingSubscriptions = this._subscriptions[eventName];
    if (existingSubscriptions == null) {
      existingSubscriptions = {};
      this._subscriptions[eventName] = existingSubscriptions;
    }

    return existingSubscriptions as { [id: number]: (data: ProviderEventData<T>) => void };
  }
}

function foldSubscriptions(
  subscriptions: Iterable<ContractUpdatesSubscription>,
  except?: ContractUpdatesSubscription
): { before: ContractUpdatesSubscription, after: ContractUpdatesSubscription } {
  const before = { state: false, transactions: false };
  const after = except != null ? Object.assign({}, before) : before;

  for (const item of subscriptions) {
    if (after.transactions && after.state) {
      break;
    }

    before.state ||= item.state;
    before.transactions ||= item.transactions;
    if (item != except) {
      after.state ||= item.state;
      after.transactions ||= item.transactions;
    }
  }

  return { before, after };
}

const provider = new ProviderRpcClient();

export default provider;

interface ISendInternal {
  from: Address,
  amount: string,
  /**
   * @default true
   */
  bounce?: boolean,
}

interface ISendExternal {
  publicKey: string,
  stateInit?: string,
}

interface IContractMethod<I, O> {
  /**
   * Target contract address
   */
  readonly address: Address
  readonly abi: string
  readonly method: string
  readonly params: I

  /**
   * Sends internal message and returns wallet transactions
   *
   * @param args
   */
  send(args: ISendInternal): Promise<Transaction>

  /**
   * Sends external message and returns contract transaction with parsed output
   *
   * @param args
   */
  sendExternal(args: ISendExternal): Promise<{ transaction: Transaction, output?: O }>

  /**
   * Runs message locally
   */
  call(): Promise<(O | undefined) & { _tvmExitCode: number }>
}

type IContractMethods<C> = {
  [K in AbiFunctionName<C>]: (params: AbiFunctionParams<C, K>) => IContractMethod<AbiFunctionParams<C, K>, AbiFunctionOutput<C, K>>
}

type ContractFunction = { name: string, inputs?: AbiParam[], outputs?: AbiParam[] }

export class Contract<Abi> {
  private readonly _abi: string;
  private readonly _functions: { [name: string]: { inputs: AbiParam[], outputs: AbiParam[] } };
  private readonly _address: Address;
  private readonly _methods: IContractMethods<Abi>;

  constructor(abi: Abi, address: Address) {
    this._abi = JSON.stringify(abi);
    this._functions = ((abi as any).functions as ContractFunction[]).reduce((functions, item) => {
      functions[item.name] = { inputs: item.inputs || [], outputs: item.outputs || [] };
      return functions;
    }, {} as typeof Contract.prototype._functions);
    this._address = address;

    class ContractMethod implements IContractMethod<any, any> {
      readonly params: TokensObject;

      constructor(private readonly functionAbi: { inputs: AbiParam[], outputs: AbiParam[] }, readonly abi: string, readonly address: Address, readonly method: string, params: any) {
        this.params = transformToSerializedObject(params);
      }

      async send(args: ISendInternal): Promise<Transaction> {
        const { transaction } = await provider.api.sendMessage({
          sender: args.from.toString(),
          recipient: this.address.toString(),
          amount: args.amount,
          bounce: args.bounce == null ? true : args.bounce,
          payload: {
            abi: this.abi,
            method: this.method,
            params: this.params
          }
        });
        return transaction;
      }

      async sendExternal(args: ISendExternal): Promise<{ transaction: Transaction, output?: any }> {
        let { transaction, output } = await provider.api.sendExternalMessage({
          publicKey: args.publicKey,
          recipient: this.address.toString(),
          stateInit: args.stateInit,
          payload: {
            abi: this.abi,
            method: this.method,
            params: this.params
          }
        });

        if (output != null) {
          (output as ParsedTokensObject) = transformToParsedObject(this.functionAbi.outputs, output);
        }

        return { transaction, output };
      }

      async call(): Promise<any> {
        let { output, code } = await provider.api.runLocal({
          address: this.address.toString(),
          functionCall: {
            abi: this.abi,
            method: this.method,
            params: this.params
          }
        });

        if (output == null) {
          output = {};
        } else {
          (output as ParsedTokensObject) = transformToParsedObject(this.functionAbi.outputs, output);
        }

        output._tvmExitCode = code;

        return output;
      }
    }

    this._methods = new Proxy({}, {
      get: <K extends AbiFunctionName<Abi>>(_object: {}, method: K) => {
        const rawAbi = (this._functions as any)[method];
        return (params: AbiFunctionParams<Abi, K>) => new ContractMethod(rawAbi, this._abi, this._address, method, params);
      }
    }) as unknown as IContractMethods<Abi>;
  }

  public get methods() {
    return this._methods;
  }
}
