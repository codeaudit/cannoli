import {
	ChatCompletionFunctions,
	ChatCompletionRequestMessage,
	CreateChatCompletionRequest,
	OpenAIApi,
} from "openai";
import { Canvas } from "./canvas";
import {
	CallNode,
	DisplayNode,
	DynamicReferenceNode,
	FloatingNode,
} from "./models/node";
import { CannoliObject, CannoliVertex } from "./models/object";
import { Vault } from "obsidian";
import pLimit from "p-limit";
import { CannoliObjectStatus } from "./models/graph";

export type StoppageReason = "user" | "error" | "complete";

interface Limit {
	(fn: () => Promise<ChatCompletionRequestMessage | Error>): Promise<
		ChatCompletionRequestMessage | Error
	>;
}

export interface Stoppage {
	reason: StoppageReason;
	usage: Record<string, Usage>;
	totalCost: number;
	message?: string; // Additional information, like an error message
}

export interface Usage {
	model: Model;
	modelUsage: ModelUsage;
}

export interface Model {
	name: string;
	promptTokenPrice: number;
	completionTokenPrice: number;
}

export interface ModelUsage {
	promptTokens: number;
	completionTokens: number;
	apiCalls: number;
	totalCost: number;
}

export interface OpenAIConfig {
	model: string;
	frequency_penalty: number | undefined;
	presence_penalty: number | undefined;
	stop: string[] | undefined;
	function_call: string | undefined;
	functions: ChatCompletionFunctions[] | undefined;
	temperature: number | undefined;
	top_p: number | undefined;
}

enum DagCheckState {
	UNVISITED,
	VISITING,
	VISITED,
}

export function isValidKey(
	key: string,
	config: OpenAIConfig
): key is keyof OpenAIConfig {
	return key in config;
}

export class Run {
	graph: Record<string, CannoliObject> = {};
	onFinish: (stoppage: Stoppage) => void;
	vault: Vault;

	openai: OpenAIApi | null;
	llmLimit: Limit;
	canvas: Canvas | null;
	isMock: boolean;
	isStopped = false;

	modelInfo: Record<string, Model> = {
		"gpt-4": {
			name: "gpt-4",
			promptTokenPrice: 0.03 / 1000, // $0.03 per 1K tokens
			completionTokenPrice: 0.06 / 1000, // $0.06 per 1K tokens
		},

		"gpt-3.5-turbo": {
			name: "gpt-3.5-turbo",
			promptTokenPrice: 0.0015 / 1000, // $0.0015 per 1K tokens
			completionTokenPrice: 0.002 / 1000, // $0.002 per 1K tokens
		},
	};

	openaiConfig: OpenAIConfig = {
		model: "gpt-3.5-turbo",
		frequency_penalty: undefined,
		presence_penalty: undefined,
		stop: undefined,
		function_call: undefined,
		functions: undefined,
		temperature: undefined,
		top_p: undefined,
	};

	usage: Record<string, Usage>;

	constructor({
		graph,
		onFinish,
		vault,
		isMock,
		canvas,
		openai,
		openAiConfig,
		llmLimit,
	}: {
		graph: Record<string, CannoliObject>;
		vault: Vault;

		onFinish?: (stoppage: Stoppage) => void;
		isMock?: boolean;
		canvas?: Canvas;
		openai?: OpenAIApi;
		openAiConfig?: OpenAIConfig;
		llmLimit?: number;
	}) {
		this.graph = graph;
		this.onFinish = onFinish ?? ((stoppage: Stoppage) => {});
		this.isMock = isMock ?? false;
		this.vault = vault;
		this.canvas = canvas ?? null;
		this.openai = openai ?? null;
		this.usage = {};
		this.llmLimit = pLimit(llmLimit ?? 10);

		// Set the default openai config
		this.openaiConfig = openAiConfig ? openAiConfig : this.openaiConfig;

		// Set this as the run for every object
		for (const object of Object.values(this.graph)) {
			object.setRun(this);
		}
	}

	async start() {
		//if (this.isMock) {
		// Log the graph
		this.logGraph();
		//}
		// Setup listeners
		this.setupListeners();

		// Reset the graph
		this.reset();

		// Validate the graph
		this.validate();

		// If we have a canvas, remove all error nodes
		if (this.canvas) {
			await this.canvas.enqueueRemoveAllErrorNodes();
		}

		// Call execute on all root objects
		for (const object of Object.values(this.graph)) {
			if (object.dependencies.length === 0) {
				object.execute();
			}
		}
	}

	error(message: string) {
		this.isStopped = true;

		this.onFinish({
			reason: "error",
			usage: this.calculateAllLLMCosts(),
			totalCost: this.getTotalCost(),
			message,
		});

		throw new Error(message);
	}

	stop() {
		this.isStopped = true;

		this.onFinish({
			reason: "user",
			usage: this.calculateAllLLMCosts(),
			totalCost: this.getTotalCost(),
		});
	}

	reset() {
		this.isStopped = false;

		// Call reset on all objects
		for (const object of Object.values(this.graph)) {
			object.reset();
		}
	}

	validate() {
		// Call validate on each object
		for (const object of Object.values(this.graph)) {
			object.validate();
		}

		// Check if the graph is a DAG
		if (!this.isDAG(this.graph)) {
			// Find a node and call error on it
			for (const object of Object.values(this.graph)) {
				if (object instanceof CannoliVertex)
					object.error(
						"Cycle detected in graph. Please make sure the graph is a DAG.\n(exception: edges between groups and their members)"
					);
			}
		}
	}

	setupListeners() {
		for (const object of Object.values(this.graph)) {
			object.on("update", (obj, status, message) => {
				this.objectUpdated(obj, status, message);
			});
		}
	}

	getDefaultConfig(): OpenAIConfig {
		return this.openaiConfig;
	}

	objectUpdated(
		object: CannoliObject,
		status: CannoliObjectStatus,
		message?: string
	) {
		switch (status) {
			case CannoliObjectStatus.Complete: {
				this.objectCompleted(object);
				break;
			}
			case CannoliObjectStatus.Rejected: {
				this.objectRejected(object);
				break;
			}
			case CannoliObjectStatus.Executing: {
				this.objectExecuting(object);
				break;
			}
			case CannoliObjectStatus.Pending: {
				this.objectPending(object);
				break;
			}
			case CannoliObjectStatus.Error: {
				this.objectError(object, message);
				break;
			}
			case CannoliObjectStatus.Warning: {
				this.objectWarning(object, message);
				break;
			}

			default: {
				throw new Error(`Unknown status: ${status}`);
			}
		}
	}

	objectCompleted(object: CannoliObject) {
		if (!this.isMock && this.canvas) {
			if (object instanceof CallNode) {
				this.canvas.enqueueChangeNodeColor(object.id, "4");
			} else if (
				object instanceof DisplayNode ||
				object instanceof DynamicReferenceNode ||
				object instanceof FloatingNode
			) {
				this.canvas.enqueueChangeNodeText(object.id, object.text);
			}
		}

		if (this.allObjectsFinished() && !this.isStopped) {
			this.isStopped = true;
			this.onFinish({
				reason: "complete",
				usage: this.calculateAllLLMCosts(),
				totalCost: this.getTotalCost(),
			});
		}
	}

	objectRejected(object: CannoliObject) {
		if (this.allObjectsFinished() && !this.isStopped) {
			this.isStopped = true;
			this.onFinish({
				reason: "complete",
				usage: this.calculateAllLLMCosts(),
				totalCost: this.getTotalCost(),
			});
		}
	}

	objectExecuting(object: CannoliObject) {
		if (!this.isMock && this.canvas && object instanceof CallNode) {
			this.canvas.enqueueChangeNodeColor(object.id, "3");
		}
	}

	objectPending(object: CannoliObject) {
		if (this.canvas && object instanceof CallNode) {
			this.canvas.enqueueChangeNodeColor(object.id, "0");
		}
	}

	objectError(object: CannoliObject, message?: string) {
		if (this.canvas && object instanceof CannoliVertex) {
			this.canvas.enqueueAddErrorNode(
				object.id,
				message ?? "Unknown error"
			);
		}

		this.error(message ?? "Unknown error");
	}

	objectWarning(object: CannoliObject, message?: string) {
		if (this.canvas && object instanceof CannoliVertex) {
			this.canvas.enqueueAddWarningNode(
				object.id,
				message ?? "Unknown warning"
			);
		}
	}

	allObjectsFinished(): boolean {
		// Check if all objects are complete or rejected
		for (const object of Object.values(this.graph)) {
			if (
				object.status !== CannoliObjectStatus.Complete &&
				object.status !== CannoliObjectStatus.Rejected
			) {
				return false;
			}
		}

		return true;
	}

	isDAG(objects: Record<string, CannoliObject>): boolean {
		const states = new Map<CannoliObject, DagCheckState>();

		function visit(obj: CannoliObject): boolean {
			if (states.get(obj) === DagCheckState.VISITING) {
				return false; // Cycle detected
			}

			if (states.get(obj) === DagCheckState.VISITED) {
				return true; // Already visited
			}

			states.set(obj, DagCheckState.VISITING);

			for (const dependency of obj.getAllDependencies()) {
				if (!visit(dependency)) {
					return false; // Cycle detected in one of the dependencies
				}
			}

			states.set(obj, DagCheckState.VISITED);
			return true;
		}

		for (const obj of Object.values(objects)) {
			if (states.get(obj) !== DagCheckState.VISITED) {
				if (!visit(obj)) {
					return false; // Cycle detected
				}
			}
		}

		return true;
	}

	async callLLM(
		request: CreateChatCompletionRequest,
		verbose?: boolean
	): Promise<ChatCompletionRequestMessage | Error> {
		return this.llmLimit(
			async (): Promise<ChatCompletionRequestMessage | Error> => {
				// Only call LLM if we're not mocking
				if (this.isMock || !this.openai) {
					let textMessages = "";

					// For each message, convert it to a string, including the role and the content, and a function call if present
					for (const message of request.messages) {
						if (message.function_call) {
							textMessages += `${message.role}: ${message.content} ${message.function_call} `;
						} else {
							textMessages += `${message.role}: ${message.content} `;
						}
					}

					// Estimate the tokens using the rule of thumb that 4 characters is 1 token
					const promptTokens = textMessages.length / 4;

					if (!this.usage[request.model]) {
						// Find the right model from this.models
						const model = this.modelInfo[request.model];

						this.usage[request.model] = {
							model: model,
							modelUsage: {
								promptTokens: 0,
								completionTokens: 0,
								apiCalls: 0,
								totalCost: 0,
							},
						};
					}

					this.usage[request.model].modelUsage.promptTokens +=
						promptTokens;
					this.usage[request.model].modelUsage.apiCalls += 1;

					// Find the choice function
					const choiceFunction = request.functions?.find(
						(fn) => fn.name === "enter_choice"
					);

					if (
						choiceFunction &&
						choiceFunction.parameters &&
						choiceFunction.parameters.properties.choice.enum
							.length > 0
					) {
						// Pick one of the choices randomly
						const randomChoice =
							choiceFunction.parameters.properties.choice.enum[
								Math.floor(
									Math.random() *
										choiceFunction.parameters.properties
											.choice.enum.length
								)
							];

						return {
							role: "assistant",
							content: "Mock response",
							function_call: {
								name: "enter_choice",
								arguments: `{
									"choice" : "${randomChoice}"
								}`,
							},
						};
					}

					return {
						role: "assistant",
						content: "Mock response",
					};
				}

				// Catch any errors
				try {
					const response = await this.openai.createChatCompletion(
						request
					);

					if (verbose) {
						console.log(
							"Input Messages:\n" +
								JSON.stringify(request.messages, null, 2) +
								"\n\nResponse Message:\n" +
								JSON.stringify(
									response.data.choices[0].message,
									null,
									2
								)
						);
					}

					if (response.data.usage) {
						const model = this.modelInfo[request.model];
						if (!this.usage[model.name]) {
							this.usage[model.name] = {
								model: model,
								modelUsage: {
									promptTokens: 0,
									completionTokens: 0,
									apiCalls: 0,
									totalCost: 0,
								},
							};
						}

						this.usage[model.name].modelUsage.promptTokens +=
							response.data.usage.prompt_tokens;
						this.usage[model.name].modelUsage.completionTokens +=
							response.data.usage.completion_tokens;
						this.usage[model.name].modelUsage.apiCalls += 1;
					}
					return response.data.choices[0].message
						? response.data.choices[0].message
						: Error("No message returned");
				} catch (e) {
					return e;
				}
			}
		);
	}

	createChoiceFunction(choices: string[]): ChatCompletionFunctions {
		return {
			name: "enter_choice",
			description:
				"Enter your answer to the question above using this function.",
			parameters: {
				type: "object",
				properties: {
					choice: {
						type: "string",
						enum: choices,
					},
				},
				required: ["choice"],
			},
		};
	}

	createListFunction(tags: string[]): ChatCompletionFunctions {
		const properties: Record<string, { type: string }> = {};

		tags.forEach((tag) => {
			properties[tag] = {
				type: "string",
			};
		});

		return {
			name: "enter_answers",
			description:
				"Use this function to enter the requested information for each key.",
			parameters: {
				type: "object",
				properties,
				required: tags,
			},
		};
	}

	calculateAllLLMCosts(): Record<string, Usage> {
		for (const usage of Object.values(this.usage)) {
			usage.modelUsage.totalCost = this.calculateLLMCostForModel(usage);
		}
		return this.usage;
	}

	calculateLLMCostForModel(usage: Usage): number {
		const promptCost =
			usage.model.promptTokenPrice * usage.modelUsage.promptTokens;
		const completionCost =
			usage.model.completionTokenPrice *
			usage.modelUsage.completionTokens;
		const totalCost = promptCost + completionCost;
		return totalCost;
	}

	getTotalCost(): number {
		let totalCost = 0;
		for (const usage of Object.values(this.usage)) {
			totalCost += this.calculateLLMCostForModel(usage);
		}
		return totalCost;
	}

	async editNote(name: string, newContent: string): Promise<void | null> {
		// Only edit the file if we're not mocking
		if (this.isMock) {
			return;
		}

		// If the first line is a header that matches the name of the reference, remove it
		const lines = newContent.split("\n");
		if (lines[0].startsWith("#")) {
			const header = lines[0].slice(2);
			if (header === name) {
				lines.shift();
				newContent = lines.join("\n").trim();
			}
		}

		// Get the file
		const file = this.vault.getMarkdownFiles().find((file) => {
			return file.basename === name;
		});

		if (!file) {
			return null;
		}

		// Newcontent callback function
		const onEdit = (data: string) => {
			return newContent;
		};

		await this.vault.process(file, onEdit);

		return;
	}

	async getNote(name: string): Promise<string | null> {
		// Get the file
		const file = this.vault.getMarkdownFiles().find((file) => {
			return file.basename === name;
		});

		if (!file) {
			return null;
		}

		// Read the file
		let content = await this.vault.read(file);

		// Prepend the note's name as a header
		const header = `# ${name}\n`;

		content = header + content;

		return content;
	}

	async createNoteAtExistingPath(
		noteName: string,
		path: string,
		content?: string,
		verbose = false
	): Promise<boolean> {
		// Create the path by appending the note name to the path with .md
		const fullPath = `${path}/${noteName}.md`;

		// Check if a note already exists at the path
		const note = this.vault.getMarkdownFiles().find((file) => {
			return file.path === fullPath;
		});

		if (note) {
			return false;
		}

		// Create the note
		await this.vault.create(fullPath, content ?? "");

		if (verbose) {
			console.log(`Note "${noteName}" created at path "${fullPath}"`);
		}

		return true;
	}

	async createNoteAtNewPath(
		noteName: string,
		path: string,
		content?: string,
		verbose = false
	): Promise<boolean> {
		// Create the path by appending the note name to the path with .md
		const fullPath = `${path}/${noteName}.md`;

		// Create the note
		await this.vault.create(fullPath, content ?? "");

		if (verbose) {
			console.log(`Note "${noteName}" created at path "${fullPath}"`);
		}

		return true;
	}

	async createFolder(path: string, verbose = false): Promise<boolean> {
		// Check if the path already exists
		const folder = this.vault.getAbstractFileByPath(path);

		if (folder) {
			return false;
		}

		// Create the folder
		this.vault.createFolder(path);

		if (verbose) {
			console.log(`Folder created at path "${path}"`);
		}

		return true;
	}

	async moveNote(
		noteName: string,
		oldPath: string,
		newPath: string,
		verbose = false
	): Promise<boolean> {
		// Create the paths by appending the note name to the paths with .md
		const oldFullPath = `${oldPath}/${noteName}.md`;
		const newFullPath = `${newPath}/${noteName}.md`;

		// Get the note
		const note = this.vault.getMarkdownFiles().find((file) => {
			return file.path === oldFullPath;
		});

		if (!note) {
			return false;
		}

		// Move the note
		await this.vault.rename(note, newFullPath);

		if (verbose) {
			console.log(
				`Note "${noteName}" moved from path "${oldFullPath}" to path "${newFullPath}"`
			);
		}

		return true;
	}

	logGraph() {
		for (const node of Object.values(this.graph)) {
			console.log(node.logDetails());
		}
	}
}
