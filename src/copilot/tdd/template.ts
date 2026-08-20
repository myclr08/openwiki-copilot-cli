import { readFile } from "node:fs/promises";

/** One numbered section of the company TDD template. */
export interface TddTemplateSection {
  /** The section's number in the template, e.g. 4. */
  number: number;

  /** The heading text after the number, e.g. "Veritabanı İşlemleri". */
  title: string;

  /**
   * The section's `> Açıklama:` note — a filling instruction for the writing
   * pass. Never part of the generated document; the template itself says to
   * delete these notes.
   */
  instruction: string;
}

/** The section model a template parses into. */
export interface TddTemplate {
  sections: TddTemplateSection[];
}

/**
 * Markdown mirror of the company's "MVP - Teknik Detay" PDF template.
 *
 * The `> Açıklama:` blockquotes carry the PDF's filling notes; the writing
 * prompt forwards them as instructions and forbids them in the output.
 * `--template` substitutes any other file with the same `## N. Title` shape.
 */
export const BUNDLED_TDD_TEMPLATE = `# MVP - Teknik Detay

**MVP Ad:** [Doldurulacak]

**MVP Jira:** [Doldurulacak — Jira linki]

**Tarih:** [DD/MM/YYYY]

**Hazırlayan:** [İsim Soyisim]

## 1. MVP Temel Kapsamı

> Açıklama: Hangi problem çözülüyor veya hangi özellik kazandırılıyor? Çok
> detaya girmeden, iş ihtiyacını özetleyiniz.

## 2. Üzerinde Çalışılacak Uygulamalar

> Açıklama: Bu geliştirme hangi mikroservisleri, önyüz projelerini, batch
> job'ları veya harici entegrasyon noktalarını etkiliyor? Sadece isim listesi
> veya kısa bir bağımlılık özeti yeterlidir. Mikroservisler, Önyüz
> Uygulamaları ve Harici Sistemler olarak ayırınız.

## 3. Frontend Tarafında Yapılacak Teknik İşler

> Açıklama: Önyüz işi yoksa "Kapsam Dışı" yazıp geçiniz. Hangi ekranlar
> eklenecek veya mevcut ekranlarda ne değişecek? Yeni butonlar, validasyon
> kuralları veya state yönetimi gereksinimlerini maddeler halinde yazınız.

## 4. Backend Tarafında Yapılacak Teknik İşler

> Açıklama: Backend işi yoksa "Kapsam Dışı" yazıp geçiniz. İş mantığı nerede
> kurgulanacak, hangi servisler birbirini çağıracak? Validasyonlar,
> hesaplamalar veya entegrasyon mantıkları nelerdir? Yeni API uçları veya
> event-driven (SAGA/Kafka/RabbitMQ) yapıları nelerdir? Metot tipi (GET/POST)
> ve kısa açıklama yeterlidir; request/response şeması gerekmez. SAGA
> tanımında RequestSaga ya da EventSaga kullanımını belirtiniz.

## 5. ROTA Akış İşlemleri

> Açıklama: ROTA akışları ile ilgili çalışma yoksa "Kapsam Dışı" yazıp
> geçiniz. Yeni akış oluşturulacak mı? Mevcut akış üzerinde değişiklik var
> mı? Yeni Adım, Yeni Aksiyon ve Akış Datası düzenlemelerini belirtiniz.

## 6. Veritabanı İşlemleri

> Açıklama: Veritabanı değişikliği yoksa "Kapsam Dışı" yazıp geçiniz. Yeni
> tablo oluşturulacak mı? Mevcut tablolara yeni kolon eklenecek mi? Veri
> migrasyonu (update script) gerekecek mi? DWH veya Insight rapor çalışması
> olacak mı?

## 7. Tanımlar

> Açıklama: Bu özelliği canlıya alırken veya işletirken ihtiyaç duyulacak
> konfigürasyonlar nelerdir? Parametre, EOD tanımı, ELK index, monitoring,
> safe, yetki, network (Layer7 ya da 3rd party erişimler), notification ve
> feature flag kullanımını değerlendiriniz.

## 8. Onay İşlemleri

> Açıklama: Herhangi bir onay ihtiyacı yoksa "Kapsam Dışı" yazıp geçiniz.
> Genel onay veya harici onay yapısı olacaksa ana teknik tasarım dokümanına
> eklendi mi?

## 9. Diyagram Çizimleri

> Açıklama: Ana teknik tasarım dokümanındaki diyagramda MVP gösterimi yapılıp
> yapılmadığını belirtiniz. Transactional işlemler için Idempotency & Data
> Consistency sequence diyagram durumunu ve diyagramdaki sayfa bilgisini
> belirtiniz.
`;

/** Matches a numbered section heading: `## 4. Backend ...`. */
const SECTION_HEADING = /^## (\d+)\. (.+)$/u;

/**
 * Template placeholders that must not survive into a finished document.
 * `[Netleştirilecek: …]` is deliberately absent: it is the tool's own marker
 * for an open question, reported as a count, not a defect.
 */
const TEMPLATE_PLACEHOLDER =
  /\[(?:Örn|Buraya|Doldurulacak|İsim Soyisim|DD\/MM|Yapılacak iş|Adım ismi|Aksion ismi|Yapılan düzenlemeler)/u;

/** The tool's own open-question marker. */
const CLARIFICATION_MARKER = /\[Netleştirilecek:/gu;

/** Parses a template's numbered sections and their Açıklama instructions. */
export function parseTddTemplate(markdown: string): TddTemplate {
  const sections: TddTemplateSection[] = [];
  let current: TddTemplateSection | undefined;

  for (const line of markdown.split("\n")) {
    const heading = SECTION_HEADING.exec(line.trim());

    if (heading) {
      current = {
        number: Number(heading[1]),
        title: (heading[2] ?? "").trim(),
        instruction: "",
      };
      sections.push(current);
      continue;
    }

    if (current && line.trimStart().startsWith(">")) {
      const text = line.trimStart().replace(/^>\s?/u, "").trim();

      if (text) {
        current.instruction = current.instruction
          ? `${current.instruction} ${text}`
          : text;
      }
    }
  }

  if (sections.length === 0) {
    throw new Error(
      "The TDD template contains no numbered '## N. Title' sections; nothing to fill.",
    );
  }

  return { sections };
}

/** Loads the template to fill: `--template <file>`, or the bundled default. */
export async function loadTddTemplate(
  templatePath?: string | null,
): Promise<{ raw: string; template: TddTemplate }> {
  const raw = templatePath
    ? await readFile(templatePath, "utf8")
    : BUNDLED_TDD_TEMPLATE;

  return { raw, template: parseTddTemplate(raw) };
}

/**
 * Checks a finished document against the template it was filled from: every
 * numbered section present, no template placeholder left behind. Reports —
 * never rewrites. Whether the document is good enough to paste is the
 * developer's call, so problems come back as warnings, not errors.
 */
export function validateTddDocument(
  template: TddTemplate,
  document: string,
): { warnings: string[]; pendingClarifications: number } {
  const warnings: string[] = [];

  for (const section of template.sections) {
    const heading = new RegExp(`^#{2,3} ${section.number}\\. `, "mu");

    if (!heading.test(document)) {
      warnings.push(`Bölüm eksik: ${section.number}. ${section.title}`);
    }
  }

  for (const line of document.split("\n")) {
    if (TEMPLATE_PLACEHOLDER.test(line)) {
      warnings.push(`Doldurulmamış şablon alanı: ${line.trim().slice(0, 80)}`);
    }
  }

  return {
    warnings,
    pendingClarifications: document.match(CLARIFICATION_MARKER)?.length ?? 0,
  };
}
