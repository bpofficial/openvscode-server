/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type * as Proto from '../protocol';
import { ITypeScriptServiceClient } from '../typescriptService';
import API from '../utils/api';
import { Disposable } from '../utils/dispose';
import * as fileSchemes from '../utils/fileSchemes';
import { isTypeScriptDocument } from '../utils/languageModeIds';
import { equals } from '../utils/objects';
import { ResourceMap } from '../utils/resourceMap';

namespace ExperimentalProto {
	export interface UserPreferences extends Proto.UserPreferences {
		displayPartsForJSDoc: true

		includeInlayParameterNameHints?: 'none' | 'literals' | 'all';
		includeInlayParameterNameHintsWhenArgumentMatchesName?: boolean;
		includeInlayFunctionParameterTypeHints?: boolean;
		includeInlayVariableTypeHints?: boolean;
		includeInlayPropertyDeclarationTypeHints?: boolean;
		includeInlayFunctionLikeReturnTypeHints?: boolean;
		includeInlayEnumMemberValueHints?: boolean;
	}
}

interface FileConfiguration {
	readonly formatOptions: Proto.FormatCodeSettings;
	readonly preferences: Proto.UserPreferences;
}

function areFileConfigurationsEqual(a: FileConfiguration, b: FileConfiguration): boolean {
	return equals(a, b);
}

export default class FileConfigurationManager extends Disposable {
	private readonly formatOptions: ResourceMap<Promise<FileConfiguration | undefined>>;

	public constructor(
		private readonly client: ITypeScriptServiceClient,
		onCaseInsensitiveFileSystem: boolean
	) {
		super();
		this.formatOptions = new ResourceMap(undefined, { onCaseInsensitiveFileSystem });
		vscode.workspace.onDidCloseTextDocument(textDocument => {
			// When a document gets closed delete the cached formatting options.
			// This is necessary since the tsserver now closed a project when its
			// last file in it closes which drops the stored formatting options
			// as well.
			this.formatOptions.delete(textDocument.uri);
		}, undefined, this._disposables);
	}

	public async ensureConfigurationForDocument(
		document: vscode.TextDocument,
		token: vscode.CancellationToken
	): Promise<void> {
		const formattingOptions = this.getFormattingOptions(document);
		if (formattingOptions) {
			return this.ensureConfigurationOptions(document, formattingOptions, token);
		}
	}

	private getFormattingOptions(
		document: vscode.TextDocument
	): vscode.FormattingOptions | undefined {
		const editor = vscode.window.visibleTextEditors.find(editor => editor.document.fileName === document.fileName);
		return editor
			? {
				tabSize: editor.options.tabSize,
				insertSpaces: editor.options.insertSpaces
			} as vscode.FormattingOptions
			: undefined;
	}

	public async ensureConfigurationOptions(
		document: vscode.TextDocument,
		options: vscode.FormattingOptions,
		token: vscode.CancellationToken
	): Promise<void> {
		const file = this.client.toOpenedFilePath(document);
		if (!file) {
			return;
		}

		const currentOptions = this.getFileOptions(document, options);
		const cachedOptions = this.formatOptions.get(document.uri);
		if (cachedOptions) {
			const cachedOptionsValue = await cachedOptions;
			if (cachedOptionsValue && areFileConfigurationsEqual(cachedOptionsValue, currentOptions)) {
				return;
			}
		}

		let resolve: (x: FileConfiguration | undefined) => void;
		this.formatOptions.set(document.uri, new Promise<FileConfiguration | undefined>(r => resolve = r));

		const args: Proto.ConfigureRequestArguments = {
			file,
			...currentOptions,
		};
		try {
			const response = await this.client.execute('configure', args, token);
			resolve!(response.type === 'response' ? currentOptions : undefined);
		} finally {
			resolve!(undefined);
		}
	}

	public async setGlobalConfigurationFromDocument(
		document: vscode.TextDocument,
		token: vscode.CancellationToken,
	): Promise<void> {
		const formattingOptions = this.getFormattingOptions(document);
		if (!formattingOptions) {
			return;
		}

		const args: Proto.ConfigureRequestArguments = {
			file: undefined /*global*/,
			...this.getFileOptions(document, formattingOptions),
		};
		await this.client.execute('configure', args, token);
	}

	public reset() {
		this.formatOptions.clear();
	}

	private getFileOptions(
		document: vscode.TextDocument,
		options: vscode.FormattingOptions
	): FileConfiguration {
		return {
			formatOptions: this.getFormatOptions(document, options),
			preferences: this.getPreferences(document)
		};
	}

	private getFormatOptions(
		document: vscode.TextDocument,
		options: vscode.FormattingOptions
	): Proto.FormatCodeSettings {
		const config = vscode.workspace.getConfiguration(
			isTypeScriptDocument(document) ? 'typescript.format' : 'javascript.format',
			document.uri);

		return {
			tabSize: options.tabSize,
			indentSize: options.tabSize,
			convertTabsToSpaces: options.insertSpaces,
			// We can use \n here since the editor normalizes later on to its line endings.
			newLineCharacter: '\n',
			insertSpaceAfterCommaDelimiter: config.get<boolean>('insertSpaceAfterCommaDelimiter'),
			insertSpaceAfterConstructor: config.get<boolean>('insertSpaceAfterConstructor'),
			insertSpaceAfterSemicolonInForStatements: config.get<boolean>('insertSpaceAfterSemicolonInForStatements'),
			insertSpaceBeforeAndAfterBinaryOperators: config.get<boolean>('insertSpaceBeforeAndAfterBinaryOperators'),
			insertSpaceAfterKeywordsInControlFlowStatements: config.get<boolean>('insertSpaceAfterKeywordsInControlFlowStatements'),
			insertSpaceAfterFunctionKeywordForAnonymousFunctions: config.get<boolean>('insertSpaceAfterFunctionKeywordForAnonymousFunctions'),
			insertSpaceBeforeFunctionParenthesis: config.get<boolean>('insertSpaceBeforeFunctionParenthesis'),
			insertSpaceAfterOpeningAndBeforeClosingNonemptyParenthesis: config.get<boolean>('insertSpaceAfterOpeningAndBeforeClosingNonemptyParenthesis'),
			insertSpaceAfterOpeningAndBeforeClosingNonemptyBrackets: config.get<boolean>('insertSpaceAfterOpeningAndBeforeClosingNonemptyBrackets'),
			insertSpaceAfterOpeningAndBeforeClosingNonemptyBraces: config.get<boolean>('insertSpaceAfterOpeningAndBeforeClosingNonemptyBraces'),
			insertSpaceAfterOpeningAndBeforeClosingEmptyBraces: config.get<boolean>('insertSpaceAfterOpeningAndBeforeClosingEmptyBraces'),
			insertSpaceAfterOpeningAndBeforeClosingTemplateStringBraces: config.get<boolean>('insertSpaceAfterOpeningAndBeforeClosingTemplateStringBraces'),
			insertSpaceAfterOpeningAndBeforeClosingJsxExpressionBraces: config.get<boolean>('insertSpaceAfterOpeningAndBeforeClosingJsxExpressionBraces'),
			insertSpaceAfterTypeAssertion: config.get<boolean>('insertSpaceAfterTypeAssertion'),
			placeOpenBraceOnNewLineForFunctions: config.get<boolean>('placeOpenBraceOnNewLineForFunctions'),
			placeOpenBraceOnNewLineForControlBlocks: config.get<boolean>('placeOpenBraceOnNewLineForControlBlocks'),
			semicolons: config.get<Proto.SemicolonPreference>('semicolons'),
		};
	}

	private getPreferences(document: vscode.TextDocument): Proto.UserPreferences {
		if (this.client.apiVersion.lt(API.v290)) {
			return {};
		}

		const config = vscode.workspace.getConfiguration(
			isTypeScriptDocument(document) ? 'typescript' : 'javascript',
			document.uri);

		const preferencesConfig = vscode.workspace.getConfiguration(
			isTypeScriptDocument(document) ? 'typescript.preferences' : 'javascript.preferences',
			document.uri);

		const preferences: ExperimentalProto.UserPreferences = {
			quotePreference: this.getQuoteStylePreference(preferencesConfig),
			importModuleSpecifierPreference: getImportModuleSpecifierPreference(preferencesConfig),
			importModuleSpecifierEnding: getImportModuleSpecifierEndingPreference(preferencesConfig),
			// @ts-expect-error until TS 4.5 protocol update
			jsxAttributeCompletionStyle: getJsxAttributeCompletionStyle(preferencesConfig),
			allowTextChangesInNewFiles: document.uri.scheme === fileSchemes.file,
			providePrefixAndSuffixTextForRename: preferencesConfig.get<boolean>('renameShorthandProperties', true) === false ? false : preferencesConfig.get<boolean>('useAliasesForRenames', true),
			allowRenameOfImportPath: true,
			includeAutomaticOptionalChainCompletions: config.get<boolean>('suggest.includeAutomaticOptionalChainCompletions', true),
			provideRefactorNotApplicableReason: true,
			generateReturnInDocTemplate: config.get<boolean>('suggest.jsdoc.generateReturns', true),
			includeCompletionsForImportStatements: config.get<boolean>('suggest.includeCompletionsForImportStatements', true),
			includeCompletionsWithSnippetText: config.get<boolean>('suggest.includeCompletionsWithSnippetText', true),
			includeCompletionsWithClassMemberSnippets: config.get<boolean>('suggest.includeCompletionsWithClassMemberSnippets', true),
			allowIncompleteCompletions: true,
			displayPartsForJSDoc: true,
			...getInlayHintsPreferences(config),
		};

		return preferences;
	}

	private getQuoteStylePreference(config: vscode.WorkspaceConfiguration) {
		switch (config.get<string>('quoteStyle')) {
			case 'single': return 'single';
			case 'double': return 'double';
			default: return this.client.apiVersion.gte(API.v333) ? 'auto' : undefined;
		}
	}
}

export class InlayHintSettingNames {
	static readonly parameterNamesSuppressWhenArgumentMatchesName = 'inlayHints.parameterNames.suppressWhenArgumentMatchesName';
	static readonly parameterNamesEnabled = 'inlayHints.parameterTypes.enabled';
	static readonly variableTypesEnabled = 'inlayHints.variableTypes.enabled';
	static readonly propertyDeclarationTypesEnabled = 'inlayHints.propertyDeclarationTypes.enabled';
	static readonly functionLikeReturnTypesEnabled = 'inlayHints.functionLikeReturnTypes.enabled';
	static readonly enumMemberValuesEnabled = 'inlayHints.enumMemberValues.enabled';
}

export function getInlayHintsPreferences(config: vscode.WorkspaceConfiguration) {
	return {
		includeInlayParameterNameHints: getInlayParameterNameHintsPreference(config),
		includeInlayParameterNameHintsWhenArgumentMatchesName: !config.get<boolean>(InlayHintSettingNames.parameterNamesSuppressWhenArgumentMatchesName, true),
		includeInlayFunctionParameterTypeHints: config.get<boolean>(InlayHintSettingNames.parameterNamesEnabled, false),
		includeInlayVariableTypeHints: config.get<boolean>(InlayHintSettingNames.variableTypesEnabled, false),
		includeInlayPropertyDeclarationTypeHints: config.get<boolean>(InlayHintSettingNames.propertyDeclarationTypesEnabled, false),
		includeInlayFunctionLikeReturnTypeHints: config.get<boolean>(InlayHintSettingNames.functionLikeReturnTypesEnabled, false),
		includeInlayEnumMemberValueHints: config.get<boolean>(InlayHintSettingNames.enumMemberValuesEnabled, false),
	} as const;
}

function getInlayParameterNameHintsPreference(config: vscode.WorkspaceConfiguration) {
	switch (config.get<string>('inlayHints.parameterNames.enabled')) {
		case 'none': return 'none';
		case 'literals': return 'literals';
		case 'all': return 'all';
		default: return undefined;
	}
}

function getImportModuleSpecifierPreference(config: vscode.WorkspaceConfiguration) {
	switch (config.get<string>('importModuleSpecifier')) {
		case 'project-relative': return 'project-relative';
		case 'relative': return 'relative';
		case 'non-relative': return 'non-relative';
		default: return undefined;
	}
}

function getImportModuleSpecifierEndingPreference(config: vscode.WorkspaceConfiguration) {
	switch (config.get<string>('importModuleSpecifierEnding')) {
		case 'minimal': return 'minimal';
		case 'index': return 'index';
		case 'js': return 'js';
		default: return 'auto';
	}
}

function getJsxAttributeCompletionStyle(config: vscode.WorkspaceConfiguration) {
	switch (config.get<string>('jsxAttributeCompletionStyle')) {
		case 'braces': return 'braces';
		case 'none': return 'none';
		default: return 'auto';
	}
}
