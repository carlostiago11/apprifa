const { DataTypes } = require("sequelize");

module.exports = {
  version: "2026091201-raffle-discount-percent",
  async up({ queryInterface }) {
    const columns = await queryInterface.describeTable("Raffles");
    if (!columns.discountPercent) {
      await queryInterface.addColumn("Raffles", "discountPercent", {
        type: DataTypes.DECIMAL(5, 2),
        allowNull: false,
        defaultValue: 10,
      });
    }
  },
};
