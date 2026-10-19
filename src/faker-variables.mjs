import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let provider;
// Explicit no-argument catalogue: user input never selects a module or property path.
const catalogue = {
  $randomFirstName: ["person", "firstName"],
  $randomLastName: ["person", "lastName"],
  $randomFullName: ["person", "fullName"],
  $randomNamePrefix: ["person", "prefix"],
  $randomNameSuffix: ["person", "suffix"],
  $randomJobArea: ["person", "jobArea"],
  $randomJobDescriptor: ["person", "jobDescriptor"],
  $randomJobTitle: ["person", "jobTitle"],
  $randomJobType: ["person", "jobType"],
  $randomCity: ["location", "city"],
  $randomStreetName: ["location", "street"],
  $randomStreetAddress: ["location", "streetAddress"],
  $randomCountry: ["location", "country"],
  $randomCountryCode: ["location", "countryCode"],
  $randomLatitude: ["location", "latitude"],
  $randomLongitude: ["location", "longitude"],
  $randomEmail: ["internet", "email"],
  $randomUserName: ["internet", "username"],
  $randomDomainName: ["internet", "domainName"],
  $randomDomainSuffix: ["internet", "domainSuffix"],
  $randomDomainWord: ["internet", "domainWord"],
  $randomUserAgent: ["internet", "userAgent"],
  $randomBankAccount: ["finance", "accountNumber", { length: 8 }],
  $randomBankAccountName: ["finance", "accountName"],
  $randomBankAccountBic: ["finance", "bic"],
  $randomBankAccountIban: ["finance", "iban"],
  $randomTransactionType: ["finance", "transactionType"],
  $randomCurrencyCode: ["finance", "currencyCode"],
  $randomCurrencyName: ["finance", "currencyName"],
  $randomCurrencySymbol: ["finance", "currencySymbol"],
  $randomBitcoin: ["finance", "bitcoinAddress"],
  $randomCompanyName: ["company", "name"],
  $randomBs: ["company", "buzzPhrase"],
  $randomBsAdjective: ["company", "buzzAdjective"],
  $randomBsBuzz: ["company", "buzzVerb"],
  $randomBsNoun: ["company", "buzzNoun"],
  $randomCatchPhrase: ["company", "catchPhrase"],
  $randomCatchPhraseAdjective: ["company", "catchPhraseAdjective"],
  $randomCatchPhraseDescriptor: ["company", "catchPhraseDescriptor"],
  $randomCatchPhraseNoun: ["company", "catchPhraseNoun"],
  $randomDatabaseColumn: ["database", "column"],
  $randomDatabaseType: ["database", "type"],
  $randomDatabaseCollation: ["database", "collation"],
  $randomDatabaseEngine: ["database", "engine"],
  $randomDateFuture: ["date", "future"],
  $randomDatePast: ["date", "past"],
  $randomDateRecent: ["date", "recent"],
  $randomWeekday: ["date", "weekday"],
  $randomMonth: ["date", "month"],
  $randomProductName: ["commerce", "productName"],
  $randomPrice: ["commerce", "price"],
  $randomProductAdjective: ["commerce", "productAdjective"],
  $randomProductMaterial: ["commerce", "productMaterial"],
  $randomProduct: ["commerce", "product"],
  $randomDepartment: ["commerce", "department"],
  $randomWord: ["lorem", "word"],
  $randomWords: ["lorem", "words"],
  $randomSentence: ["lorem", "sentence"],
  $randomSentences: ["lorem", "sentences"],
  $randomParagraph: ["lorem", "paragraph"],
  $randomParagraphs: ["lorem", "paragraphs"],
  $randomText: ["lorem", "text"],
  $randomSlug: ["lorem", "slug"],
  $randomLines: ["lorem", "lines"],
  $randomFileName: ["system", "fileName"],
  $randomFileType: ["system", "fileType"],
  $randomFileExt: ["system", "fileExt"],
  $randomMimeType: ["system", "mimeType"],
  $randomDirectoryPath: ["system", "directoryPath"],
  $randomFilePath: ["system", "filePath"],
  $randomCommonFileName: ["system", "commonFileName"],
  $randomCommonFileType: ["system", "commonFileType"],
  $randomCommonFileExt: ["system", "commonFileExt"],
};
export const fakerVariableNames = Object.freeze(Object.keys(catalogue));
export function fakerVariable(name) {
  if (!Object.hasOwn(catalogue, name)) return undefined;
  // Only the English locale is loaded, and only when a supported variable is used.
  const faker = (provider ??= require("@faker-js/faker/locale/en").faker);
  const [group, method, options] = catalogue[name];
  const result =
    options === undefined
      ? faker[group][method]()
      : faker[group][method](options);
  const value = result instanceof Date ? result.toISOString() : result;
  if (
    !["string", "number", "boolean"].includes(typeof value) ||
    Buffer.byteLength(String(value)) > 65536
  )
    throw Error("Faker变量输出无效或超过64KiB");
  return value;
}
