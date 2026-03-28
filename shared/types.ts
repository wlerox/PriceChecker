/** Ortak ürün sonucu (API + UI) */
export interface Product {
  store: string;
  title: string;
  price: number;
  currency: string;
  url: string;
}

export interface SearchError {
  store: string;
  message: string;
}

export interface SearchResponse {
  /** Gönderilen arama metni */
  query: string;
  /** İsteğe bağlı ürün tipi / kategori (örn. elektronik, ekran kartı, mont) */
  searchType?: string;
  results: Product[];
  errors?: SearchError[];
}
