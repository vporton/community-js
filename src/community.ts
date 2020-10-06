import Arweave from 'arweave';
import { interactWrite, createContractFromTx, readContract, interactWriteDryRun, interactRead } from 'smartweave';
import { JWKInterface } from 'arweave/node/lib/wallet';
import Transaction from 'arweave/web/lib/transaction';
import { BalancesInterface, VaultInterface, VoteInterface, RoleInterface, StateInterface, InputInterface, ResultInterface } from './faces';
import Utils from './utils';

export default class Community {
  private readonly contractSrc: string = 'ngMml4jmlxu0umpiQCsHgPX2pb_Yz6YDB8f7G6j-tpI';
  private readonly mainContract: string = 'mzvUgNc8YFk0w5K5H7c8pyT-FC5Y_ba0r7_8766Kx74';
  private readonly txFee: number = 400000000;
  private readonly createFee: number = 9500000000;

  private arweave: Arweave;
  private wallet!: JWKInterface;
  private walletAddress!: string;
  private dummyWallet: JWKInterface;

  // Community specific variables
  private communityContract = '';
  private state!: StateInterface;
  private firstCall: boolean = true;
  private cacheRefreshInterval: number = 1000 * 60 * 2; // 2 minutes
  private stateCallInProgress: boolean = false;

  /**
   * Before interacting with Community you need to have at least Arweave initialized.
   * @param arweave - Arweave instance
   * @param wallet - JWK wallet file data
   * @param cacheRefreshInterval - Refresh interval in milliseconds for the cached state
   */
  constructor(arweave: Arweave, wallet?: JWKInterface, cacheRefreshInterval = 1000 * 60 * 2) {
    this.arweave = arweave;

    if (wallet) {
      this.wallet = wallet;
      arweave.wallets
        .jwkToAddress(wallet)
        .then((addy) => (this.walletAddress = addy))
        .catch(console.log);
    }

    if (cacheRefreshInterval) {
      this.cacheRefreshInterval = cacheRefreshInterval;
    }
  }

  /**
   * Get the Community contract ID
   * @returns {Promise<string>} The main contract ID.
   */
  public async getMainContractId(): Promise<string> {
    return this.mainContract;
  }

  /**
   * Get the current Community state.
   * @param cached - Wether to return the cached version or reload
   * @returns - The current state and sync afterwards if needed.
   */
  public async getState(cached = true): Promise<StateInterface> {
    if (!this.communityContract.length) {
      throw new Error('No community set. Use setCommunityTx to get your current state.');
    }

    if (this.firstCall) {
      this.firstCall = false;
      return this.update(true);
    }

    if (!cached || !this.state) {
      return this.update(false);
    }

    return this.state;
  }

  /**
   * Set the user wallet data.
   * @param wallet - JWK wallet file data
   * @returns The wallet address
   */
  public async setWallet(wallet: JWKInterface): Promise<string> {
    this.wallet = wallet;
    this.walletAddress = await this.arweave.wallets.jwkToAddress(this.wallet);

    return this.walletAddress;
  }

  /**
   * Set the states for a new Community using the Community contract.
   * @param name - The Community name
   * @param ticker - Currency ticker, ex: TICK
   * @param balances - an object of wallet addresses and their token balances
   * @param quorum - % of votes weight, for a proposal to be valid
   * @param support = % of votes as "yes", for a vote to be valid
   * @param voteLength - For how long (in blocks) should the vote be active
   * @param lockMinLength - What is the minimum lock time (in blocks)
   * @param lockMaxLength - What is the maximum lock time (in blocks)
   * @param vault - Vault object, optional
   * @param votes - Votes, optional
   * @param roles - Roles, optional
   *
   * @returns - The created state
   */
  public async setState(
    name: string,
    ticker: string,
    balances: BalancesInterface,
    quorum: number = 50,
    support: number = 50,
    voteLength: number = 2000,
    lockMinLength: number = 720,
    lockMaxLength: number = 10000,
    vault: VaultInterface = {},
    votes: VoteInterface[] = [],
    roles: RoleInterface = {},
  ): Promise<StateInterface> {
    // Make sure the wallet exists.
    await this.checkWallet();

    // Clean data
    name = name.trim();
    ticker = ticker.trim();
    balances = Utils.trimObj(balances);
    quorum = +quorum;
    support = +support;
    voteLength = +voteLength;
    lockMinLength = +lockMinLength;
    lockMaxLength = +lockMaxLength;
    vault = Utils.trimObj(vault);
    votes = Utils.trimObj(votes);
    roles = Utils.trimObj(roles);

    // Validations
    if (name.length < 3) {
      throw new Error('Community Name must be at least 3 characters.');
    }
    if (ticker.length < 3) {
      throw new Error('Ticker must be at least 3 characters.');
    }
    if (!Object.keys(balances).length) {
      throw new Error('At least one account need to be specified.');
    }
    for (const bal in balances) {
      if (isNaN(balances[bal]) || !Number.isInteger(balances[bal]) || balances[bal] < 1) {
        throw new Error('Address balances must be a positive integer.');
      }
    }
    if (isNaN(quorum) || quorum < 1 || quorum > 99 || !Number.isInteger(quorum)) {
      throw new Error('Quorum must be an integer between 1-99.');
    }
    quorum = quorum / 100;
    if (isNaN(support) || support < 1 || support > 99 || !Number.isInteger(support)) {
      throw new Error('Support must be an integer between 1-99.');
    }
    support = support / 100;
    if (isNaN(voteLength) || !Number.isInteger(voteLength) || voteLength < 1) {
      throw new Error('Vote Length must be a positive integer.');
    }
    if (isNaN(lockMinLength) || lockMinLength < 1 || !Number.isInteger(lockMinLength)) {
      throw new Error('Lock Min Length must be a positive integer.');
    }
    if (isNaN(lockMaxLength) || lockMaxLength < lockMinLength || !Number.isInteger(lockMaxLength)) {
      throw new Error('Lock Max Length must be a positive integer, greater than lockMinLength.');
    }
    if (Object.keys(vault).length) {
      for (const key of Object.keys(vault)) {
        for (const k in vault[key]) {
          if (isNaN(vault[key][k].balance) || !Number.isInteger(vault[key][k]) || vault[key][k].balance < 1) {
            throw new Error('Vault balance must be a positive integer.');
          }
        }
      }
    }

    const settings: [string, any][] = [
      ['quorum', quorum],
      ['support', support],
      ['voteLength', voteLength],
      ['lockMinLength', lockMinLength],
      ['lockMaxLength', lockMaxLength],
    ];

    // Set the state
    this.state = {
      name,
      ticker,
      balances,
      vault,
      votes,
      roles,
      settings: new Map(settings),
    };

    return this.state;
  }

  /**
   * Create a new Community with the current, previously saved (with `setState`) state.
   * @returns The created community transaction ID.
   */
  public async create(): Promise<string> {
    // Create the new Community.
    await this.chargeFee('CreateCommunity', this.createFee);

    const toSubmit: any = this.state;
    toSubmit.settings = Array.from(this.state.settings);

    // @ts-ignore
    const communityID = await createContractFromTx(this.arweave, this.wallet, this.contractSrc, JSON.stringify(toSubmit));
    this.communityContract = communityID;

    return communityID;
  }

  /**
   * Get the current create cost of a community.
   * @param inAr - Return in winston or AR
   * @param options - If return inAr is set to true, these options are used to format the returned AR value.
   */
  public async getCreateCost(inAr = false, options?: { formatted: boolean; decimals: number; trim: boolean }): Promise<string> {
    const byteSize = new Blob([JSON.stringify(this.state)]).size;
    const res = await this.arweave.api.get(`/price/${byteSize + this.createFee}`);

    if (inAr) {
      return this.arweave.ar.winstonToAr(res.data, options);
    }

    return res.data;
  }

  /**
   * Get the current action (post interaction) cost of a community.
   * @param inAr - Return in winston or AR
   * @param options - If return inAr is set to true, these options are used to format the returned AR value.
   */
  public async getActionCost(inAr = false, options?: { formatted: boolean; decimals: number; trim: boolean }): Promise<string> {
    const res = await this.arweave.api.get(`/price/${this.txFee}`);

    if (inAr) {
      return this.arweave.ar.winstonToAr(res.data, options);
    }

    return res.data;
  }

  /**
   * Set the Community interactions to this transaction ID.
   * @param txId Community's Transaction ID
   * @returns boolean - True if successful, false if error.
   */
  public async setCommunityTx(txId: string): Promise<boolean> {
    // reset state
    this.state = null;
    this.communityContract = txId;

    try {
      await this.getState(false);
    } catch (e) {
      this.state = null;
      this.communityContract = null;
      console.log(e);
      return false;
    }

    return true;
  }

  /**
   * Do a GET call to any function on the contract.
   * @param params - InputInterface
   * @returns ResultInterface
   */
  public async get(params: InputInterface = { function: 'balance' }): Promise<ResultInterface> {
    if (!this.wallet && !this.dummyWallet) {
      this.dummyWallet = await this.arweave.wallets.generate();
    }

    // @ts-ignore
    return interactRead(this.arweave, this.wallet || this.dummyWallet, this.communityContract, params);
  }

  /**
   * Get the target or current wallet token balance
   * @param target The target wallet address
   * @returns Current target token balance
   */
  public async getBalance(target: string = this.walletAddress): Promise<number> {
    const res = await this.get({ function: 'balance', target });
    return res.balance;
  }

  /**
   * Get the target or current wallet unlocked token balance
   * @param target The target wallet address
   * @returns Current target token balance
   */
  public async getUnlockedBalance(target: string = this.walletAddress): Promise<number> {
    const res = await this.get({ function: 'unlockedBalance', target });
    return res.balance;
  }

  /**
   * Get the target or current wallet vault balance
   * @param target The target wallet address
   * @returns Current target token balance
   */
  public async getVaultBalance(target: string = this.walletAddress): Promise<number> {
    const res = await this.get({ function: 'vaultBalance', target });
    return res.balance;
  }

  /**
   * Get the target or current wallet role
   * @param target The target wallet address
   * @returns Current target role
   */
  public async getRole(target: string = this.walletAddress): Promise<string> {
    const res = await this.get({ function: 'role', target });
    return res.role;
  }

  /**
   * Select one of your community holders based on their weighted total balance.
   * @param balances  - State balances, optional.
   * @param vault - State vault, optional.
   */
  public async selectWeightedHolder(balances: BalancesInterface = this.state.balances, vault: VaultInterface = this.state.vault) {
    if (!this.state) {
      throw new Error('Need to initilate the state and worker.');
    }

    let totalTokens = 0;
    for (const addy of Object.keys(balances)) {
      totalTokens += balances[addy];
    }
    for (const addy of Object.keys(vault)) {
      if (!vault[addy].length) continue;
      const vaultBalance = vault[addy].map((a) => a.balance).reduce((a, b) => a + b, 0);
      totalTokens += vaultBalance;
      if (addy in balances) {
        balances[addy] += vaultBalance;
      } else {
        balances[addy] = vaultBalance;
      }
    }

    const weighted: BalancesInterface = {};
    for (const addy of Object.keys(balances)) {
      weighted[addy] = balances[addy] / totalTokens;
    }

    let sum = 0;
    const r = Math.random();
    for (const addy of Object.keys(weighted)) {
      sum += weighted[addy];
      if (r <= sum && weighted[addy] > 0) {
        return addy;
      }
    }

    return null;
  }

  // Setters

  /**
   *
   * @param target - Target Wallet Address
   * @param qty - Amount of the token to send
   * @returns The transaction ID for this action
   */
  public async transfer(target: string, qty: number): Promise<string> {
    await this.chargeFee('transfer');
    return this.interact({ function: 'transfer', target, qty });
  }

  /**
   * Lock your balances in a vault to earn voting weight.
   * @param qty - Positive integer for the quantity to lock
   * @param lockLength - Length of the lock, in blocks
   * @returns The transaction ID for this action
   */
  public async lockBalance(qty: number, lockLength: number): Promise<string> {
    await this.chargeFee('lockBalance');
    return this.interact({ function: 'lock', qty, lockLength });
  }

  /**
   * Unlock all your locked balances that are over the lock period.
   * @returns The transaction ID for this action
   */
  public async unlockVault(): Promise<string> {
    await this.chargeFee('unlockVault');
    return this.interact({ function: 'unlock' });
  }

  /**
   * Increase the lock time (in blocks) of a vault.
   * @param vaultId - The vault index position to increase
   * @param lockLength - Length of the lock, in blocks
   * @returns The transaction ID for this action
   */
  public async increaseVault(vaultId: number, lockLength: number): Promise<string> {
    await this.chargeFee('increaseVault');
    return this.interact({ function: 'increaseVault', id: vaultId, lockLength });
  }

  /**
   * Create a new vote
   * @param params VoteInterface without the "function"
   * @returns The transaction ID for this action
   */
  public async proposeVote(params: VoteInterface): Promise<string> {
    const pCopy: VoteInterface = JSON.parse(JSON.stringify(params));

    if (pCopy.type === 'set') {
      if (pCopy.key === 'quorum' || pCopy.key === 'support' || pCopy.key === 'lockMinLength' || pCopy.key === 'lockMaxLength') {
        pCopy.value = +pCopy.value;
      }

      if (pCopy.key === 'quorum' || pCopy.key === 'support') {
        if (pCopy.value > 0 && pCopy.value < 100) {
          pCopy.value = pCopy.value / 100;
        } else if (pCopy.value <= 0 || pCopy.value >= 100) {
          throw new Error('Invalid value.');
        }
      }

      if (pCopy.key === 'lockMinLength' && (pCopy.value < 1 || pCopy.value > this.state.settings.get('lockMaxLength'))) {
        throw new Error('Invalid minimum lock length.');
      }
      if (pCopy.key === 'lockMaxLength' && (pCopy.value < 1 || pCopy.value < this.state.settings.get('lockMinLength'))) {
        throw new Error('Invalid maximum lock length.');
      }
    }

    await this.chargeFee('proposeVote');
    const input: InputInterface = { ...pCopy, function: 'propose' };

    return this.interact(input);
  }

  /**
   * Cast a vote on an existing, and active, vote proposal.
   * @param id - The vote ID, this is the index of the vote in votes
   * @param cast - Cast your vote with 'yay' (for yes) or 'nay' (for no)
   * @returns The transaction ID for this action
   */
  public async vote(id: number, cast: 'yay' | 'nay'): Promise<string> {
    await this.chargeFee('vote');
    return this.interact({ function: 'vote', id, cast });
  }

  /**
   * Finalize a vote, to run the desired vote details if approved, or reject it and close.
   * @param id - The vote ID, this is the index of the vote in votes
   * @returns The transaction ID for this action
   */
  public async finalize(id: number): Promise<string> {
    await this.chargeFee('finalize');
    return this.interact({ function: 'finalize', id });
  }

  /**
   * Charge a fee for each Community's interactions.
   * @param action - Current action name. Usually the same as the method name
   * @param bytes - Bytes to get it's price to charge
   */
  private async chargeFee(action: string, bytes: number = this.txFee): Promise<void> {
    // TODO: Check if the user has enough balance for this action
    const fee = (await this.arweave.api.get(`/price/${bytes}`)).data;
    const balance = await this.arweave.wallets.getBalance(this.walletAddress);

    console.log(balance, fee);

    if (+balance < +fee) {
      throw new Error('Not enough balance.');
    }

    // @ts-ignore
    const target = await readContract(this.arweave, this.mainContract).then((state: StateInterface) => {
      return this.selectWeightedHolder(state.balances, state.vault);
    });

    const tx = await this.arweave.createTransaction(
      {
        target,
        quantity: fee.toString(),
      },
      this.wallet,
    );

    await this.setDefaultTags(tx);
    tx.addTag('Action', action);

    await this.arweave.transactions.sign(tx, this.wallet);
    const txId = tx.id;

    const res = await this.arweave.transactions.post(tx);
    if (res.status !== 200 && res.status !== 202) {
      throw new Error('Error while submiting a transaction.');
    }
  }

  /**
   * Set default tags to each transaction sent from CommunityJS.
   * @param tx - Transaction to set the defaults.
   */
  private async setDefaultTags(tx: Transaction, communityId: string = this.communityContract): Promise<void> {
    tx.addTag('App-Name', 'CommunityJS');
    tx.addTag('App-Version', '1.0.7');
    tx.addTag('Community-Contract', communityId);
    tx.addTag('Community-Ticker', this.state.ticker);
  }

  /**
   * Function used to check if the user is already logged in
   */
  private async checkWallet(): Promise<void> {
    if (!this.wallet) {
      throw new Error('You first need to set the user wallet, you can do this while on new Community(..., wallet) or using setWallet(wallet).');
    }
  }

  private async update(recall = false): Promise<StateInterface> {
    if (!this.communityContract.length) {
      setTimeout(() => this.update(), this.cacheRefreshInterval);
      return;
    }

    if (this.stateCallInProgress) {
      const getLastState = async (): Promise<StateInterface> => {
        if (this.stateCallInProgress) {
          return new Promise((resolve) => setTimeout(() => resolve(getLastState()), 1000));
        }

        return this.state;
      };
      return getLastState();
    }

    this.stateCallInProgress = true;

    // @ts-ignore
    const res: StateInterface = await readContract(this.arweave, this.communityContract);
    res.settings = new Map(res.settings);
    this.state = res;

    this.stateCallInProgress = false;

    if (recall) {
      setTimeout(() => this.update(true), this.cacheRefreshInterval);
    }
    return this.state;
  }

  /**
   * The most important function, it writes to the contract.
   * @param input - InputInterface
   */
  private async interact(input: InputInterface): Promise<string> {
    // @ts-ignore
    const res = await interactWriteDryRun(this.arweave, this.wallet, this.communityContract, input);
    if (res.type === 'error') {
      //  || res.type === 'exception'
      throw new Error(res.result);
    }

    // @ts-ignore
    return interactWrite(this.arweave, this.wallet, this.communityContract, input);
  }

  async uploadFile(content: ArrayBuffer, contentType: string) {
    // Make sure the wallet exists.
    await this.checkWallet();

    let transaction = await this.arweave.createTransaction({
      data: new Uint8Array(content),
    }, this.wallet);
    transaction.addTag('Content-Type', contentType);
    await this.arweave.transactions.sign(transaction, this.wallet);
    const response = await this.arweave.transactions.post(transaction);
    return response;
  }
}
