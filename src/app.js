const express = require('express');
const bodyParser = require('body-parser');
const { sequelize, Job } = require('./model')
const { getProfile } = require('./middleware/getProfile');
const { Sequelize, DataTypes } = require('sequelize');
const app = express();
app.use(bodyParser.json());
app.set('sequelize', sequelize)
app.set('models', sequelize.models)

/**
 * GET /contracts/:id
 * @returns contract by id
 */
app.get('/contracts/:id', getProfile, async (req, res) => {
    const { Contract } = req.app.get('models')
    try {
        // Fetch Contract
        const contract = await Contract.findOne({
            where: {
                id: req.params.id,
                [Sequelize.Op.or]: [
                    { ContractorId: req.profile.id },
                    { ClientId: req.profile.id }
                ]
            }
        });

        if (contract) {
            res.json(contract);
        } else {
            res.status(404).json({ error: "Contract not found." })
        }
    } catch (error) {
        res.status(500).json({ error: "Internal server error." });
    }
})

/**
 * GET /contracts
 * @returns all non terminated contracts by id 
 */
app.get('/contracts/', getProfile, async (req, res) => {
    const { Contract } = req.app.get('models')
    try {
        // Fetch Contracts
        const contracts = await Contract.findAll({
            where: {
                status: {
                    [Sequelize.Op.not]: 'terminated'
                },
                [Sequelize.Op.or]: [
                    { ContractorId: req.profile.id },
                    { ClientId: req.profile.id }
                ]
            }
        });

        if (contracts) {
            res.json(contracts);
        } else {
            res.status(404).json({ error: "No contracts found" })
        }
    } catch (error) {
        res.status(500).json({ error: "Internal server error." })
    }
})

/**
 * GET /jobs/unpaid
 * @ returns all unpaid jobs for a profile
 */
app.get('/jobs/unpaid', getProfile, async (req, res) => {
    const { Contract, Job } = req.app.get('models')
    try {
        // Fetch Contracts
        const contracts = await Contract.findAll({
            where: {
                status: {
                    [Sequelize.Op.eq]: 'in_progress'
                },
                [Sequelize.Op.or]: [
                    { ContractorId: req.profile.id },
                    { ClientId: req.profile.id }
                    // TODO: Ensure one or the other
                ]
            }
        });

        const contractIds = contracts.map(contract => contract.id);

        const jobs = await Job.findAll({
            where: {
                paymentDate: null,
                ContractId: {
                    [Sequelize.Op.in]: contractIds
                }
            }
        });

        if (jobs && jobs.length > 0) {
            res.json(jobs);
        } else {
            res.status(404).json({ error: "no unpaid jobs found" });
        }

    } catch (error) {
        res.status(500).json({ error: "Internal server error." })
    }
});


/**
 * POST /jobs/:job_id/pay
 * @returns "success (200) if transaction completed"
 */
app.post('/jobs/:job_id/pay', getProfile, async (req, res) => {
    const { Profile, Contract, Job } = req.app.get('models')

    try {
        // Find job by id
        const job = await Job.findOne({
            where: {
                id: req.params.job_id
            }
        });

        if (!job) {
            return res.status(404).json({ error: "Job not found" });
        }
        if (job.paid) {
            return res.status(401).json({ error: "Job already paid" });
        }

        // Find client by id
        const client = await Profile.findOne({
            where: {
                id: req.profile.id,
                type: 'client'
            }
        });

        // Invalid client ids cause issues...
        if (!client) {
            return res.status(404).json({ error: "Client not found" });
        }
        if (client.balance < job.price) {
            return res.status(401).json({ error: "Account balance insufficient" });
        }

        // Find contract associated with the job
        const contract = await Contract.findByPk(job.ContractId);
        const contractor = await Profile.findOne({
            where: {
                id: contract.ContractorId,
                type: 'contractor'
            }
        });

        // console.log("PRE TRANSACTION")
        // console.log("Job Price: " + job.price)
        // console.log("Client: " + client.firstName + " " + client.balance);
        // console.log("Contractor: " + contractor.firstName + " " + contractor.balance);


        const result = await sequelize.transaction(async (t) => {
            return Promise.all([
                Profile.update(
                    { balance: client.balance - job.price },
                    { where: { id: client.id }, transaction: t }
                ),
                Profile.update(
                    { balance: contractor.balance + job.price },
                    { where: { id: contractor.id }, transaction: t }
                ),
                Job.update(
                    { paid: true, paymentDate: new Date() },
                    { where: { id: job.id }, transaction: t }
                )
            ])
        });

        // Refetch to get updated balances
        const updatedClient = await Profile.findByPk(client.id);
        const updatedContractor = await Profile.findByPk(contractor.id);
        console.log("POST TRANSACTION");
        console.log("Client: " + updatedClient.firstName + " " + updatedClient.balance);
        console.log("Contractor: " + updatedContractor.firstName + " " + updatedContractor.balance);

        res.json("Job paid successfully")

    } catch (error) {
        res.status(500).json({ error: "Internal server error." + error });
    }
});


app.post('/balances/deposit/:userId', getProfile, async (req, res) => {
    const { Profile, Contract, Job } = req.app.get('models');

    try {
        const client = await Profile.findOne({
            where: {
                id: req.params.userId,
                type: 'client'
            }
        });

        if (!client) {
            return res.status(404).json({ error: "Client not found" });
        }

        const contracts = await Contract.findAll({
            where: {
                status: { [Sequelize.Op.not]: 'terminated' },
                ClientId: req.params.userId
            }
        });

        if (!contracts || contracts.length === 0) {
            return res.status(404).json({ error: "No contracts found for user" });
        }

        const contractIds = contracts.map(contract => contract.id);
        const unpaidJobs = await Job.findAll({
            where: {
                paid: null,
                ContractId: {
                    [Sequelize.Op.in]: contractIds
                }
            }
        });

        if (!unpaidJobs || unpaidJobs.length === 0) {
            return res.status(404).json({ error: "No unpaid jobs found for user." });
        }

        const totalOwed = unpaidJobs.reduce((sum, job) => sum + job.price, 0);
        const maxDeposit = totalOwed * 0.25;
        const depositAmount = parseFloat(req.body.amount);

        if (!depositAmount) {
            return res.status(400).json({ error: "No amount specified." });
        }
        if (depositAmount > maxDeposit) {
            return res.status(400).json({ error: `You can't deposit more than 25% of your total owed amount. Maximum allowable deposit: $${maxDeposit.toFixed(2)}` });
        }

        await Profile.update(
            { balance: client.balance + depositAmount },
            { where: { id: req.params.userId } }
        );

        // Refetch the updated client balance
        const updatedClient = await Profile.findByPk(req.params.userId);

        res.json({ success: `Deposited $${depositAmount.toFixed(2)}. New balance: $${updatedClient.balance.toFixed(2)}` });

    } catch (error) {
        res.status(500).json({ error: "Internal server error: " + error });
    }
});


app.get('/admin/best-profession', async (req, res) => {
    const { Profile, Contract, Job } = req.app.get('models');
    const startDate = req.query.start;
    const endDate = req.query.end;

    if (!startDate || !endDate) {
        return res.status(400).json({ error: "Both start and end date are required." });
    }

    try {
        const bestProfession = await Job.findAll({
            include: [{
                model: Contract,
                attributes: [],
                include: [{
                    model: Profile,
                    attributes: ['profession'],
                    as: 'Contractor'
                }]
            }],
            where: {
                paymentDate: {
                    [Sequelize.Op.between]: [startDate, endDate]
                },
                paid: true
            },
            attributes: [
                [Sequelize.fn('sum', Sequelize.col('price')), 'totalEarnings'],
                [Sequelize.col('Contract->Contractor.profession'), 'profession']
            ],
            group: ['Contract.ContractorId', 'Contract->Contractor.profession'],
            order: [[Sequelize.fn('sum', Sequelize.col('price')), 'DESC']],
            limit: 1
        });

        if (bestProfession && bestProfession.length > 0) {
            res.json({ bestProfession: bestProfession[0].dataValues.profession });
        } else {
            res.status(404).json({ error: "No data found for the given time range." });
        }

    } catch (error) {
        res.status(500).json({ error: "Internal server error: " + error });
    }
});


app.get('/admin/best-clients', async (req, res) => {
    const { Profile, Contract, Job } = req.app.get('models');
    const startDate = req.query.start;
    const endDate = req.query.end;
    const limit = req.query.limit || 2;

    if (!startDate || !endDate) {
        return res.status(400).json({ error: "Both valid start and end date are required." });
    }

    try {
        const bestClients = await Job.findAll({
            include: [{
                model: Contract,
                attributes: [],
                include: [{
                    model: Profile,
                    attributes: ['id', 'firstName', 'lastName', 'profession'],
                    as: 'Client'
                }]
            }],
            where: {
                paymentDate: {
                    [Sequelize.Op.between]: [startDate, endDate]
                },
                paid: true
            },
            attributes: [
                [Sequelize.fn('sum', Sequelize.col('price')), 'totalPaid'],
                [Sequelize.col('Contract->Client.id'), 'clientId'],
                [Sequelize.col('Contract->Client.firstName'), 'clientFirstName'],
                [Sequelize.col('Contract->Client.lastName'), 'clientLastName']
            ],
            group: ['Contract.ClientId', 'Contract->Client.id', 'Contract->Client.firstName', 'Contract->Client.lastName'],
            order: [[Sequelize.fn('sum', Sequelize.col('price')), 'DESC']],
            limit: limit
        });

        if (bestClients && bestClients.length > 0) {
            res.json(bestClients);
        } else {
            res.status(404).json({ error: "No data found for the given time range." });
        }

    } catch (error) {
        res.status(500).json({ error: "Internal server error: " + error });
    }
});


module.exports = app;


