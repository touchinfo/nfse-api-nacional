class SefinConfig {
  static obterAmbiente() {
    const ambiente = process.env.SEFIN_AMBIENTE;

    if (!ambiente || !['1', '2'].includes(ambiente)) {
      console.error('⚠️ SEFIN_AMBIENTE não definido ou inválido no .env');
      console.error('⚠️ Use: SEFIN_AMBIENTE=1 (Produção) ou SEFIN_AMBIENTE=2 (Homologação)');
      throw new Error('SEFIN_AMBIENTE não configurado');
    }

    return ambiente;
  }

  static isProducao() {
    return this.obterAmbiente() === '1';
  }

  static getNomeAmbiente() {
    return this.isProducao() ? 'PRODUÇÃO' : 'HOMOLOGAÇÃO';
  }

  static getURLSefin() {
    return this.isProducao()
      ? 'https://sefin.nfse.gov.br'
      : 'https://sefin.producaorestrita.nfse.gov.br';
  }

  static getURLADN() {
    return this.isProducao()
      ? 'https://adn.nfse.gov.br'
      : 'https://adn.producaorestrita.nfse.gov.br';
  }

  static validarSSL() {
    return this.isProducao();
  }
}

module.exports = SefinConfig;