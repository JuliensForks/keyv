import EventEmitter from 'events';
import Keyv from 'keyv';
import {endPool, pool} from './pool';
import {
	type ClearOutput,
	type DeleteManyOutput,
	type DeleteOutput,
	type DisconnectOutput,
	type GetManyOutput,
	type GetOutput,
	type HasOutput,
	type IteratorOutput,
	type KeyvPostgresOptions,
	type Query,
	type SetOutput,
} from './types';

class KeyvPostgres<Value = any> extends EventEmitter {
	ttlSupport: boolean;
	opts: KeyvPostgresOptions;
	query: Query;
	namespace?: string;
	constructor(options: KeyvPostgresOptions) {
		super();
		this.ttlSupport = false;
		options = {dialect: 'postgres',
			uri: 'postgresql://localhost:5432', ...options};

		const connect = async () => {
			const conn = pool(options.uri!, options);
			return async (sql: string, values?: any) => {
				const data = await conn.query(sql, values);
				return data.rows;
			};
		};

		this.opts = {
			table: 'keyv',
			schema: 'public',
			keySize: 255,
			...options,
		};

		let createTable = `CREATE TABLE IF NOT EXISTS ${this.opts.schema!}.${this.opts.table!}(key VARCHAR(${Number(this.opts.keySize!)}) PRIMARY KEY, value TEXT )`;

		if (this.opts.schema !== 'public') {
			createTable = `CREATE SCHEMA IF NOT EXISTS ${this.opts.schema!}; ${createTable}`;
		}

		const connected = connect()
			.then(async query => {
				await query(createTable);
				return query;
			}).catch(error => this.emit('error', error));

		this.query = async (sqlString: string, values?: any) => connected
			// @ts-expect-error - query is not a boolean
			.then(query => query(sqlString, values));
	}

	async get(key: string): GetOutput<Value> {
		const select = `SELECT * FROM ${this.opts.schema!}.${this.opts.table!} WHERE key = $1`;
		const rows = await this.query(select, [key]);
		// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
		const row = rows[0];
		return row === undefined ? undefined : row.value;
	}

	async getMany(keys: string[]): GetManyOutput<Value> {
		const getMany = `SELECT * FROM ${this.opts.schema!}.${this.opts.table!} WHERE key = ANY($1)`;
		const rows = await this.query(getMany, [keys]);
		const results = [];

		for (const key of keys) {
			const rowIndex = rows?.findIndex(row => row.key === key);
			results.push(rowIndex > -1 ? rows[rowIndex].value : undefined);
		}

		return results;
	}

	async set(key: string, value: Value): SetOutput {
		const upsert = `INSERT INTO ${this.opts.schema!}.${this.opts.table!} (key, value)
      VALUES($1, $2) 
      ON CONFLICT(key) 
      DO UPDATE SET value=excluded.value;`;
		await this.query(upsert, [key, value]);
	}

	async delete(key: string): DeleteOutput {
		const select = `SELECT * FROM ${this.opts.schema!}.${this.opts.table!} WHERE key = $1`;
		const del = `DELETE FROM ${this.opts.schema!}.${this.opts.table!} WHERE key = $1`;
		const rows = await this.query(select, [key]);

		if (rows[0] === undefined) {
			return false;
		}

		await this.query(del, [key]);
		return true;
	}

	async deleteMany(keys: string[]): DeleteManyOutput {
		const select = `SELECT * FROM ${this.opts.schema!}.${this.opts.table!} WHERE key = ANY($1)`;
		const del = `DELETE FROM ${this.opts.schema!}.${this.opts.table!} WHERE key = ANY($1)`;
		const rows = await this.query(select, [keys]);

		if (rows[0] === undefined) {
			return false;
		}

		await this.query(del, [keys]);
		return true;
	}

	async clear(): ClearOutput {
		const del = `DELETE FROM ${this.opts.schema!}.${this.opts.table!} WHERE key LIKE $1`;
		await this.query(del, [this.namespace ? `${this.namespace}:%` : '%']);
	}

	async * iterator(namespace?: string): IteratorOutput {
		const limit = Number.parseInt(String(this.opts.iterationLimit!), 10) || 10;
		// @ts-expect-error - iterate
		async function * iterate(offset: number, options: KeyvPostgresOptions, query: Query) {
			const select = `SELECT * FROM ${options.schema!}.${options.table!} WHERE key LIKE $1 LIMIT $2 OFFSET $3`;
			const entries = await query(select, [`${namespace ? namespace + ':' : ''}%`, limit, offset]);
			if (entries.length === 0) {
				return;
			}

			for (const entry of entries) {
				offset += 1;
				yield [entry.key, entry.value];
			}

			yield * iterate(offset, options, query);
		}

		yield * iterate(0, this.opts, this.query);
	}

	async has(key: string): HasOutput {
		const exists = `SELECT EXISTS ( SELECT * FROM ${this.opts.schema!}.${this.opts.table!} WHERE key = $1 )`;
		const rows = await this.query(exists, [key]);
		return rows[0].exists;
	}

	async disconnect(): DisconnectOutput {
		await endPool();
	}
}

export = KeyvPostgres;
