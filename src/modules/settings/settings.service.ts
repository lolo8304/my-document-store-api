import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { defaultDocumentTags } from './default-document-tags';
import { UpsertDocumentTagDto } from './dto/upsert-document-tag.dto';
import { DocumentTagDefinition } from './schemas/document-tag-definition.schema';

const specialFilterTags = new Set(['no-symbol']);

@Injectable()
export class SettingsService {
  constructor(
    private readonly config: ConfigService,
    @InjectModel(DocumentTagDefinition.name) private readonly tagModel: Model<DocumentTagDefinition>,
  ) {}

  async getSettings() {
    return {
      features: {
        vectorSearchEnabled: this.config.get<string>('VECTOR_SEARCH_ENABLED') === 'true',
      },
      documentTags: await this.getDocumentTags(),
    };
  }

  async getDocumentTags() {
    await this.seedDefaultDocumentTags();
    await this.backfillDocumentTagOrder();
    const tags = await this.tagModel.find({ hidden: false }).sort({ order: 1, createdAt: 1, _id: 1 }).lean();
    return tags.map((tag) => ({
      id: String(tag._id),
      short: tag.short,
      text: tag.text,
      icon: tag.icon,
      order: tag.order,
    }));
  }

  async getActiveDocumentTagTexts(): Promise<string[]> {
    const tags = await this.getDocumentTags();
    return tags.map((tag) => tag.text);
  }

  async createDocumentTag(dto: UpsertDocumentTagDto) {
    const order = await this.nextDocumentTagOrder();
    const tag = await this.tagModel.create({ short: dto.short.trim(), text: this.normalizeTagText(dto.text), icon: this.normalizeIcon(dto.icon), order, hidden: false });
    return { id: String(tag._id), short: tag.short, text: tag.text, icon: tag.icon, order: tag.order };
  }

  async updateDocumentTag(id: string, dto: UpsertDocumentTagDto) {
    const tag = await this.tagModel
      .findOneAndUpdate(
        { _id: id, hidden: false },
        { $set: { short: dto.short.trim(), text: this.normalizeTagText(dto.text), icon: this.normalizeIcon(dto.icon) } },
        { new: true },
      )
      .lean();
    if (!tag) {
      throw new NotFoundException('Document tag not found');
    }
    return { id: String(tag._id), short: tag.short, text: tag.text, icon: tag.icon, order: tag.order };
  }

  async reorderDocumentTags(ids: string[]) {
    const activeTags = await this.tagModel.find({ hidden: false }).sort({ order: 1, createdAt: 1, _id: 1 }).lean();
    const activeIds = activeTags.map((tag) => String(tag._id));
    const requestedIds = ids.filter((id, index) => ids.indexOf(id) === index && activeIds.includes(id));
    const missingIds = activeIds.filter((id) => !requestedIds.includes(id));
    const orderedIds = [...requestedIds, ...missingIds];

    await this.tagModel.bulkWrite(
      orderedIds.map((id, index) => ({
        updateOne: {
          filter: { _id: id, hidden: false },
          update: { $set: { order: index } },
        },
      })),
    );

    return this.getDocumentTags();
  }

  async hideDocumentTag(id: string) {
    const tag = await this.tagModel.findOneAndUpdate({ _id: id, hidden: false }, { $set: { hidden: true } }, { new: true }).lean();
    if (!tag) {
      throw new NotFoundException('Document tag not found');
    }
    return { id: String(tag._id), hidden: true };
  }

  async normalizeDocumentTags(tags?: string[], options: { includeSpecialFilters?: boolean } = {}): Promise<string[]> {
    if (!tags) {
      return [];
    }
    const activeTags = new Set(await this.getActiveDocumentTagTexts());
    return Array.from(
      new Set(
        tags
          .map((tag) => this.normalizeTagText(tag))
          .filter((tag) => activeTags.has(tag))
          .filter((tag) => options.includeSpecialFilters || !specialFilterTags.has(tag)),
      ),
    );
  }

  private async seedDefaultDocumentTags() {
    const count = await this.tagModel.countDocuments();
    if (count === 0) {
      await this.tagModel.insertMany(defaultDocumentTags.map((tag, index) => ({ ...tag, order: index, hidden: false })));
      return;
    }

    const existingTagTexts = new Set((await this.tagModel.find().select('text').lean()).map((tag) => tag.text));
    const missingDefaultTags = defaultDocumentTags.filter((tag) => !existingTagTexts.has(tag.text));
    if (missingDefaultTags.length > 0) {
      const nextOrder = await this.nextDocumentTagOrder();
      await this.tagModel.insertMany(missingDefaultTags.map((tag, index) => ({ ...tag, order: nextOrder + index, hidden: false })));
    }

    await Promise.all(
      defaultDocumentTags
        .filter((tag) => tag.icon)
        .map((tag) =>
          this.tagModel.updateOne(
            { text: tag.text, hidden: false, $or: [{ icon: { $exists: false } }, { icon: '' }] },
            { $set: { icon: tag.icon } },
          ),
        ),
    );
  }

  private normalizeTagText(value: string) {
    return value.trim().toLowerCase();
  }

  private normalizeIcon(value?: string) {
    const icon = value?.trim();
    return icon || undefined;
  }

  private async backfillDocumentTagOrder() {
    const unorderedTags = await this.tagModel
      .find({ $or: [{ order: { $exists: false } }, { order: null }] })
      .sort({ createdAt: 1, _id: 1 })
      .lean();
    if (unorderedTags.length === 0) {
      return;
    }

    const startOrder = await this.nextDocumentTagOrder();
    await this.tagModel.bulkWrite(
      unorderedTags.map((tag, index) => ({
        updateOne: {
          filter: { _id: tag._id },
          update: { $set: { order: startOrder + index } },
        },
      })),
    );
  }

  private async nextDocumentTagOrder() {
    const lastTag = await this.tagModel.findOne().sort({ order: -1, createdAt: -1, _id: -1 }).lean();
    return (lastTag?.order ?? -1) + 1;
  }
}
