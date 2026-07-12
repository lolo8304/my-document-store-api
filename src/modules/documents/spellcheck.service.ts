import { Injectable, Logger } from '@nestjs/common';
import { dirname, join } from 'path';
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import nspell from 'nspell';

type SpellChecker = ReturnType<typeof nspell>;
type SupportedLanguage = 'deu' | 'eng' | 'fra';

@Injectable()
export class SpellcheckService {
  private readonly logger = new Logger(SpellcheckService.name);
  private readonly checkers: Record<SupportedLanguage, SpellChecker>;

  constructor() {
    this.checkers = {
      deu: this.loadDictionary('dictionary-de'),
      eng: this.loadDictionary('dictionary-en'),
      fra: this.loadDictionary('dictionary-fr'),
    };
  }

  correctText(text: string, language: string): { text: string; corrections: number } {
    if (language !== 'deu' && language !== 'eng' && language !== 'fra') {
      return { text, corrections: 0 };
    }

    const checker = this.checkers[language];
    let corrections = 0;
    const correctedText = text.replace(/\p{L}[\p{L}'-]{2,}/gu, (word) => {
      const correction = this.correctWord(word, checker);
      if (correction !== word) {
        corrections += 1;
      }
      return correction;
    });

    if (corrections > 0) {
      this.logger.log(`Spellcheck corrected ${corrections} word(s) for language ${language}`);
    }

    return { text: correctedText, corrections };
  }

  dictionaryScore(text: string, language: string): number {
    const words = Array.from(text.matchAll(/\p{L}[\p{L}'-]{2,}/gu), (match) => match[0]).slice(0, 120);
    if (words.length === 0) {
      return 0;
    }

    const languages: SupportedLanguage[] = language === 'deu' || language === 'eng' || language === 'fra' ? [language] : ['deu', 'eng', 'fra'];
    return Math.max(
      ...languages.map((candidate) => {
        const checker = this.checkers[candidate];
        const knownWords = words.filter((word) => this.shouldSkipWord(word) || checker.correct(word)).length;
        return knownWords / words.length;
      }),
    );
  }

  private loadDictionary(packageName: string): SpellChecker {
    const requireForResolve = createRequire(__filename);
    const dictionaryRoot = dirname(requireForResolve.resolve(packageName));
    return nspell({
      aff: readFileSync(join(dictionaryRoot, 'index.aff')),
      dic: readFileSync(join(dictionaryRoot, 'index.dic')),
    });
  }

  private correctWord(word: string, checker: SpellChecker): string {
    if (this.shouldSkipWord(word) || checker.correct(word)) {
      return word;
    }

    const suggestion = checker.suggest(word)[0];
    if (!suggestion || !this.isSafeSuggestion(word, suggestion)) {
      return word;
    }

    return this.matchCase(word, suggestion);
  }

  private shouldSkipWord(word: string): boolean {
    return (
      word.length < 4 ||
      /^[A-ZÄÖÜ]{2,}$/.test(word) ||
      /['-]{2,}/.test(word) ||
      /\d/.test(word)
    );
  }

  private isSafeSuggestion(word: string, suggestion: string): boolean {
    if (suggestion.includes(' ') || suggestion.length < 3) {
      return false;
    }

    const source = word.toLowerCase();
    const target = suggestion.toLowerCase();
    if (source === target) {
      return false;
    }

    const distance = this.levenshtein(source, target);
    const maxDistance = source.length <= 6 ? 1 : Math.floor(source.length * 0.25);
    return distance <= maxDistance;
  }

  private matchCase(source: string, correction: string): string {
    if (source === source.toUpperCase()) {
      return correction.toUpperCase();
    }
    if (source[0] === source[0].toUpperCase()) {
      return `${correction[0].toUpperCase()}${correction.slice(1)}`;
    }
    return correction;
  }

  private levenshtein(a: string, b: string): number {
    const costs = Array.from({ length: b.length + 1 }, (_, index) => index);

    for (let i = 1; i <= a.length; i += 1) {
      let previous = costs[0];
      costs[0] = i;
      for (let j = 1; j <= b.length; j += 1) {
        const current = costs[j];
        costs[j] =
          a[i - 1] === b[j - 1]
            ? previous
            : Math.min(previous + 1, costs[j] + 1, costs[j - 1] + 1);
        previous = current;
      }
    }

    return costs[b.length];
  }
}
